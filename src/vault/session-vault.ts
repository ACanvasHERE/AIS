import { createHash, randomUUID } from 'node:crypto';

import type { SecretSource, SecretType, TokenGenerator, VaultEntry } from './types.js';

const TOKEN_PREFIX = '__VAULT_';
const TOKEN_SUFFIX = '__';
const BASE_HASH_LENGTH = 8;
const MAX_HASH_LENGTH = 9;
const MAX_COLLISION_SUFFIX = 15;
const TOKEN_PATTERN = /^__VAULT_([A-Z_]+)_([0-9a-f]{8,9})__$/;

export const TOKEN_REGEX = /__VAULT_[A-Z_]+_[0-9a-f]{8,9}__/g;
export const TOKEN_MAX_LENGTH = `${TOKEN_PREFIX}PRIVATE_KEY_${'f'.repeat(MAX_HASH_LENGTH)}${TOKEN_SUFFIX}`.length;

export interface SessionVaultOptions {
  sessionId?: string;
  tokenGenerator?: TokenGenerator;
}

export interface RegisterSecretOptions {
  createdAt?: number;
  hitCount?: number;
  name?: string;
  source?: SecretSource;
  token?: string;
}

function buildToken(type: SecretType, hash: string): string {
  return `${TOKEN_PREFIX}${type}_${hash}${TOKEN_SUFFIX}`;
}

function buildCollisionToken(
  secret: string,
  type: SecretType,
  sessionId: string,
  baseToken: string,
  attempt: number,
): string {
  const match = baseToken.match(TOKEN_PATTERN);
  if (!match) {
    throw new Error(`Invalid vault token format: ${baseToken}`);
  }

  if (attempt <= MAX_COLLISION_SUFFIX) {
    return buildToken(type, `${match[2].slice(0, BASE_HASH_LENGTH)}${attempt.toString(16)}`);
  }

  const hash = createHash('sha256')
    .update(`${secret}${sessionId}:${attempt}`)
    .digest('hex')
    .slice(0, MAX_HASH_LENGTH);

  return buildToken(type, hash);
}

function sortPairsBySourceLength<T extends readonly [string, string]>(pairs: T[]): T[] {
  return pairs.sort((left, right) => {
    if (right[0].length !== left[0].length) {
      return right[0].length - left[0].length;
    }

    return left[0].localeCompare(right[0]);
  });
}

export function generateToken(secret: string, type: SecretType, sessionId: string): string {
  const hash = createHash('sha256')
    .update(secret + sessionId)
    .digest('hex')
    .slice(0, BASE_HASH_LENGTH);

  return buildToken(type, hash);
}

export class SessionVault {
  private readonly nameToSecret = new Map<string, string>();
  private revisionNumber = 0;
  private readonly secretToEntry = new Map<string, VaultEntry>();
  private readonly tokenToEntry = new Map<string, VaultEntry>();
  private readonly sessionId: string;
  private readonly tokenGenerator: TokenGenerator;

  constructor(options: SessionVaultOptions = {}) {
    this.sessionId = options.sessionId ?? randomUUID();
    this.tokenGenerator = options.tokenGenerator ?? generateToken;
  }

  get size(): number {
    return this.secretToEntry.size;
  }

  get revision(): number {
    return this.revisionNumber;
  }

  register(secret: string, type: SecretType, options: RegisterSecretOptions = {}): string {
    const existingEntry = this.secretToEntry.get(secret);
    if (existingEntry) {
      this.updateExistingEntry(existingEntry, type, options);
      return existingEntry.token;
    }

    const createdAt = options.createdAt ?? Date.now();
    const baseToken = options.token ?? this.tokenGenerator(secret, type, this.sessionId);
    let token = baseToken;
    let attempt = 0;

    while (true) {
      const entryWithSameToken = this.tokenToEntry.get(token);
      if (!entryWithSameToken) {
        break;
      }

      if (entryWithSameToken.secret === secret) {
        return entryWithSameToken.token;
      }

      attempt += 1;
      token = buildCollisionToken(secret, type, this.sessionId, baseToken, attempt);
    }

    const entry: VaultEntry = {
      token,
      secret,
      type,
      createdAt,
      hitCount: options.hitCount ?? 0,
      name: normalizeEntryName(options.name),
      source: options.source ?? 'manual',
    };

    this.assertNameAvailable(entry.name, entry.secret);
    this.secretToEntry.set(secret, entry);
    this.tokenToEntry.set(token, entry);
    if (entry.name) {
      this.nameToSecret.set(entry.name, secret);
    }
    this.revisionNumber += 1;

    return token;
  }

  findByName(name: string): VaultEntry | null {
    const normalizedName = normalizeEntryName(name);
    if (!normalizedName) {
      return null;
    }

    const secret = this.nameToSecret.get(normalizedName);
    if (!secret) {
      return null;
    }

    return cloneEntry(this.secretToEntry.get(secret));
  }

  resolve(token: string): string | null {
    const entry = this.tokenToEntry.get(token);
    if (!entry) {
      return null;
    }

    entry.hitCount += 1;
    return entry.secret;
  }

  getSecretToTokenPairs(): Array<[string, string]> {
    return sortPairsBySourceLength(
      Array.from(this.secretToEntry.values(), (entry) => [entry.secret, entry.token] as const),
    ).map(([secret, token]) => [secret, token]);
  }

  snapshot(): VaultEntry[] {
    return Array.from(this.secretToEntry.values(), (entry) => ({
      ...entry,
    })).sort((left, right) => left.secret.localeCompare(right.secret));
  }

  removeByName(name: string): VaultEntry | null {
    const normalizedName = normalizeEntryName(name);
    if (!normalizedName) {
      return null;
    }

    const secret = this.nameToSecret.get(normalizedName);
    if (!secret) {
      return null;
    }

    return this.removeBySecret(secret);
  }

  getTokenToSecretPairs(): Array<[string, string]> {
    return sortPairsBySourceLength(
      Array.from(this.tokenToEntry.values(), (entry) => [entry.token, entry.secret] as const),
    ).map(([token, secret]) => [token, secret]);
  }

  isToken(value: string): boolean {
    return this.tokenToEntry.has(value);
  }

  destroy(): void {
    if (this.secretToEntry.size > 0 || this.tokenToEntry.size > 0) {
      this.revisionNumber += 1;
    }

    this.nameToSecret.clear();
    this.secretToEntry.clear();
    this.tokenToEntry.clear();
  }

  private removeBySecret(secret: string): VaultEntry | null {
    const entry = this.secretToEntry.get(secret);
    if (!entry) {
      return null;
    }

    this.secretToEntry.delete(secret);
    this.tokenToEntry.delete(entry.token);
    if (entry.name) {
      this.nameToSecret.delete(entry.name);
    }
    this.revisionNumber += 1;

    return {
      ...entry,
    };
  }

  private updateExistingEntry(
    entry: VaultEntry,
    type: SecretType,
    options: RegisterSecretOptions,
  ): void {
    let changed = false;

    if (entry.type !== type) {
      entry.type = type;
      changed = true;
    }

    if (options.createdAt !== undefined && entry.createdAt !== options.createdAt) {
      entry.createdAt = options.createdAt;
      changed = true;
    }

    if (options.hitCount !== undefined && entry.hitCount !== options.hitCount) {
      entry.hitCount = options.hitCount;
      changed = true;
    }

    if (options.source && entry.source !== options.source) {
      entry.source = options.source;
      changed = true;
    }

    const nextName = normalizeEntryName(options.name);
    if (nextName !== undefined && nextName !== entry.name) {
      this.assertNameAvailable(nextName, entry.secret);
      if (entry.name) {
        this.nameToSecret.delete(entry.name);
      }

      entry.name = nextName;
      if (nextName) {
        this.nameToSecret.set(nextName, entry.secret);
      }
      changed = true;
    }

    if (changed) {
      this.revisionNumber += 1;
    }
  }

  private assertNameAvailable(name: string | undefined, secret: string): void {
    if (!name) {
      return;
    }

    const existingSecret = this.nameToSecret.get(name);
    if (existingSecret && existingSecret !== secret) {
      throw new Error(`Secret name already exists: ${name}`);
    }
  }
}

function cloneEntry(entry: VaultEntry | undefined): VaultEntry | null {
  if (!entry) {
    return null;
  }

  return {
    ...entry,
  };
}

function normalizeEntryName(name: string | undefined): string | undefined {
  if (name === undefined) {
    return undefined;
  }

  const trimmed = name.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
