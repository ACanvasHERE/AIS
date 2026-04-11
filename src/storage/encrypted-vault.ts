import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
} from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { isSecretSource, isSecretType, type VaultEntry } from '../vault/types.js';

export const DEFAULT_VAULT_PATH = join(homedir(), '.ais', 'vault.enc');
const AES_ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const MIN_PAYLOAD_LENGTH = SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;
const FILE_MODE = 0o600;
const SCRYPT_OPTIONS = {
  N: 2 ** 14,
  r: 8,
  p: 1,
};

function isVaultEntry(value: unknown): value is VaultEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const entry = value as Partial<VaultEntry>;
  return (
    typeof entry.token === 'string' &&
    typeof entry.secret === 'string' &&
    isSecretType(entry.type) &&
    typeof entry.createdAt === 'number' &&
    Number.isFinite(entry.createdAt) &&
    typeof entry.hitCount === 'number' &&
    Number.isFinite(entry.hitCount) &&
    (entry.name === undefined || typeof entry.name === 'string') &&
    (entry.source === undefined || isSecretSource(entry.source))
  );
}

function parseVaultData(raw: string): Record<string, VaultEntry> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Vault file is corrupted');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Vault file is corrupted');
  }

  const result: Record<string, VaultEntry> = {};

  for (const [secret, entry] of Object.entries(parsed)) {
    if (!isVaultEntry(entry) || entry.secret !== secret) {
      throw new Error('Vault file is corrupted');
    }

    result[secret] = {
      token: entry.token,
      secret: entry.secret,
      type: entry.type,
      createdAt: entry.createdAt,
      hitCount: entry.hitCount,
      name: entry.name,
      source: entry.source,
    };
  }

  return result;
}

async function deriveKey(password: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, KEY_LENGTH, SCRYPT_OPTIONS, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(Buffer.from(derivedKey));
    });
  });
}

export class EncryptedVault {
  static exists(path = DEFAULT_VAULT_PATH): boolean {
    return existsSync(path);
  }

  static async save(
    data: Record<string, VaultEntry>,
    password: string,
    path = DEFAULT_VAULT_PATH,
  ): Promise<void> {
    const passwordBuffer = Buffer.from(password, 'utf8');
    const plaintextBuffer = Buffer.from(JSON.stringify(data), 'utf8');
    const salt = randomBytes(SALT_LENGTH);
    const iv = randomBytes(IV_LENGTH);
    let key: Buffer | null = null;
    let ciphertext: Buffer | null = null;
    let authTag: Buffer | null = null;

    try {
      key = await deriveKey(passwordBuffer, salt);
      const cipher = createCipheriv(AES_ALGORITHM, key, iv);
      ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
      authTag = cipher.getAuthTag();
      const payload = Buffer.concat([salt, iv, authTag, ciphertext]);

      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, payload, { mode: FILE_MODE });
      chmodSync(path, FILE_MODE);
      payload.fill(0);
    } finally {
      passwordBuffer.fill(0);
      plaintextBuffer.fill(0);
      salt.fill(0);
      iv.fill(0);
      key?.fill(0);
      ciphertext?.fill(0);
      authTag?.fill(0);
    }
  }

  static async load(password: string, path = DEFAULT_VAULT_PATH): Promise<Record<string, VaultEntry>> {
    if (!this.exists(path)) {
      return {};
    }

    const payload = await readFile(path);
    if (payload.length < MIN_PAYLOAD_LENGTH) {
      payload.fill(0);
      throw new Error('Vault file is corrupted');
    }

    const passwordBuffer = Buffer.from(password, 'utf8');
    const salt = Buffer.from(payload.subarray(0, SALT_LENGTH));
    const iv = Buffer.from(payload.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH));
    const authTag = Buffer.from(
      payload.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH),
    );
    const ciphertext = Buffer.from(payload.subarray(MIN_PAYLOAD_LENGTH));
    let key: Buffer | null = null;
    let plaintext: Buffer | null = null;

    try {
      key = await deriveKey(passwordBuffer, salt);
      const decipher = createDecipheriv(AES_ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return parseVaultData(plaintext.toString('utf8'));
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to decrypt vault: ${error.message}`);
      }

      throw new Error('Failed to decrypt vault: invalid password or corrupted file');
    } finally {
      payload.fill(0);
      passwordBuffer.fill(0);
      salt.fill(0);
      iv.fill(0);
      authTag.fill(0);
      ciphertext.fill(0);
      key?.fill(0);
      plaintext?.fill(0);
    }
  }
}
