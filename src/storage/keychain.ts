interface KeychainModule {
  deletePassword(service: string, account: string): Promise<boolean>;
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
}

type KeychainModuleLoader = () => Promise<KeychainModule | { default: KeychainModule }>;

const DEFAULT_ACCOUNT = 'vault-password';
const defaultLoader: KeychainModuleLoader = async () => import('keytar');

let keychainModuleLoader: KeychainModuleLoader = defaultLoader;

function normalizeKeychainModule(
  module: KeychainModule | { default: KeychainModule },
): KeychainModule {
  return 'default' in module ? module.default : module;
}

async function loadKeychainModule(): Promise<KeychainModule | null> {
  try {
    return normalizeKeychainModule(await keychainModuleLoader());
  } catch {
    return null;
  }
}

export function setKeychainModuleLoaderForTesting(loader: KeychainModuleLoader): void {
  keychainModuleLoader = loader;
}

export function resetKeychainModuleLoaderForTesting(): void {
  keychainModuleLoader = defaultLoader;
}

export class KeychainStore {
  static readonly SERVICE = 'ais';
  private static readonly ACCOUNT = DEFAULT_ACCOUNT;

  static async setVaultPassword(password: string): Promise<void> {
    const keychain = await loadKeychainModule();
    if (!keychain) {
      throw new Error('System keychain is not available');
    }

    try {
      await keychain.setPassword(this.SERVICE, this.ACCOUNT, password);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`System keychain is not available: ${message}`);
    }
  }

  static async getVaultPassword(): Promise<string | null> {
    const keychain = await loadKeychainModule();
    if (!keychain) {
      return null;
    }

    try {
      return await keychain.getPassword(this.SERVICE, this.ACCOUNT);
    } catch {
      return null;
    }
  }

  static async deleteVaultPassword(): Promise<void> {
    const keychain = await loadKeychainModule();
    if (!keychain) {
      return;
    }

    try {
      await keychain.deletePassword(this.SERVICE, this.ACCOUNT);
    } catch {
      // 忽略删除失败，避免在无图形环境下中断主流程。
    }
  }

  static async isAvailable(): Promise<boolean> {
    const keychain = await loadKeychainModule();
    if (!keychain) {
      return false;
    }

    try {
      await keychain.getPassword(this.SERVICE, this.ACCOUNT);
      return true;
    } catch {
      return false;
    }
  }
}
