import { randomBytes } from 'node:crypto';

import { SessionVault, type SessionVaultOptions } from '../vault/session-vault.js';
import { DEFAULT_VAULT_PATH, EncryptedVault } from './encrypted-vault.js';
import { KeychainStore } from './keychain.js';

const PASSWORD_ENV_NAME = 'AIS_VAULT_PASSWORD';

interface KeychainStoreLike {
  getVaultPassword(): Promise<string | null>;
  isAvailable(): Promise<boolean>;
  setVaultPassword(password: string): Promise<void>;
}

export interface StorageManagerOptions {
  allowEphemeralFallback?: boolean;
  env?: NodeJS.ProcessEnv;
  keychain?: KeychainStoreLike;
  persistDetectedSecrets?: boolean;
  vaultOptions?: SessionVaultOptions;
  vaultPassword?: string;
  vaultPath?: string;
}

function buildVaultRecord(vault: SessionVault, persistDetectedSecrets: boolean) {
  return Object.fromEntries(
    vault
      .snapshot()
      .filter((entry) => persistDetectedSecrets || entry.source === 'manual')
      .map((entry) => [entry.secret, entry]),
  );
}

export class StorageManager {
  private cachedPassword: string | null = null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly keychain: KeychainStoreLike;

  constructor(private readonly options: StorageManagerOptions = {}) {
    this.env = options.env ?? process.env;
    this.keychain = options.keychain ?? KeychainStore;
  }

  async initialize(): Promise<SessionVault> {
    const vault = new SessionVault(this.options.vaultOptions);
    const password = await this.getReadablePassword();

    if (!password) {
      return vault;
    }

    const persistedEntries = await EncryptedVault.load(password, this.options.vaultPath);
    for (const entry of Object.values(persistedEntries)) {
      vault.register(entry.secret, entry.type, {
        createdAt: entry.createdAt,
        hitCount: entry.hitCount,
        name: entry.name,
        source: entry.source ?? 'manual',
        token: entry.token,
      });
    }

    return vault;
  }

  async save(vault: SessionVault): Promise<void> {
    let password: string;
    try {
      password = await this.getWritablePassword();
    } catch (error) {
      if (this.options.allowEphemeralFallback && !EncryptedVault.exists(this.options.vaultPath)) {
        return;
      }

      throw error;
    }

    await EncryptedVault.save(
      buildVaultRecord(vault, this.options.persistDetectedSecrets !== false),
      password,
      this.options.vaultPath,
    );
  }

  async setup(): Promise<boolean> {
    if (EncryptedVault.exists(this.options.vaultPath)) {
      return false;
    }

    let password: string;
    try {
      password = await this.getWritablePassword();
    } catch (error) {
      if (this.options.allowEphemeralFallback) {
        return false;
      }

      throw error;
    }

    await EncryptedVault.save({}, password, this.options.vaultPath);
    return true;
  }

  getVaultPath(): string {
    return this.options.vaultPath ?? DEFAULT_VAULT_PATH;
  }

  private async getReadablePassword(): Promise<string | null> {
    const directPassword = this.getDirectPassword();
    if (directPassword) {
      this.cachedPassword = directPassword;
      return directPassword;
    }

    if (this.cachedPassword) {
      return this.cachedPassword;
    }

    const storedPassword = await this.keychain.getVaultPassword();
    if (storedPassword) {
      this.cachedPassword = storedPassword;
      return storedPassword;
    }

    if (EncryptedVault.exists(this.options.vaultPath)) {
      throw new Error(
        `Vault password is unavailable. Set ${PASSWORD_ENV_NAME} or enable the system keychain.`,
      );
    }

    return null;
  }

  private async getWritablePassword(): Promise<string> {
    const directPassword = this.getDirectPassword();
    if (directPassword) {
      this.cachedPassword = directPassword;
      return directPassword;
    }

    if (this.cachedPassword) {
      return this.cachedPassword;
    }

    const storedPassword = await this.keychain.getVaultPassword();
    if (storedPassword) {
      this.cachedPassword = storedPassword;
      return storedPassword;
    }

    if (await this.keychain.isAvailable()) {
      const seed = randomBytes(32);
      const generatedPassword = seed.toString('base64url');
      seed.fill(0);
      await this.keychain.setVaultPassword(generatedPassword);
      this.cachedPassword = generatedPassword;
      return generatedPassword;
    }

    throw new Error(
      `Vault password is unavailable. Set ${PASSWORD_ENV_NAME} when the system keychain cannot be used.`,
    );
  }

  private getDirectPassword(): string | null {
    return this.options.vaultPassword ?? this.env[PASSWORD_ENV_NAME] ?? null;
  }
}
