import { chmodSync, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { DEFAULT_AIS_STATE_PATH_DISPLAY } from './ais/state.js';
import { isSecretType, type SecretType } from './vault/types.js';

const CONFIG_FILE_MODE = 0o600;
export const DEFAULT_CONFIG_PATH = join(homedir(), '.ais', 'config.json');
export const DEFAULT_VAULT_PATH_DISPLAY = '~/.ais/vault.enc';

export interface CustomPatternConfig {
  id: string;
  regex: string;
  type: SecretType;
}

export interface AisConfig {
  ais: {
    recentLimit: number;
    statePath: string;
  };
  customPatterns: CustomPatternConfig[];
  detection: {
    context: boolean;
    entropy: boolean;
    entropyThreshold: number;
    patterns: boolean;
  };
  display: {
    debug: boolean;
  };
  storage: {
    persistSecrets: boolean;
    vaultPath: string;
  };
}

export interface LoadedConfig {
  config: AisConfig;
  exists: boolean;
  path: string;
}

export function createDefaultConfig(): AisConfig {
  return {
    ais: {
      recentLimit: 20,
      statePath: DEFAULT_AIS_STATE_PATH_DISPLAY,
    },
    customPatterns: [],
    detection: {
      patterns: true,
      context: true,
      entropy: false,
      entropyThreshold: 4,
    },
    display: {
      debug: false,
    },
    storage: {
      persistSecrets: false,
      vaultPath: DEFAULT_VAULT_PATH_DISPLAY,
    },
  };
}

export function expandHomePath(path: string): string {
  if (path === '~') {
    return homedir();
  }

  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }

  return path;
}

export function resolveConfigPath(path?: string): string {
  return expandHomePath(path ?? DEFAULT_CONFIG_PATH);
}

export async function loadConfig(path?: string): Promise<LoadedConfig> {
  const resolvedPath = resolveConfigPath(path);

  if (!existsSync(resolvedPath)) {
    return {
      config: createDefaultConfig(),
      exists: false,
      path: resolvedPath,
    };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(resolvedPath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load config: ${message}`);
  }

  return {
    config: mergeConfig(parsed),
    exists: true,
    path: resolvedPath,
  };
}

export async function saveConfig(config: AisConfig, path?: string): Promise<void> {
  const resolvedPath = resolveConfigPath(path);
  const payload = `${JSON.stringify(config, null, 2)}\n`;

  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, payload, { mode: CONFIG_FILE_MODE });
  chmodSync(resolvedPath, CONFIG_FILE_MODE);
}

function mergeConfig(raw: unknown): AisConfig {
  if (!isRecord(raw)) {
    throw new Error('Failed to load config: root must be an object');
  }

  const config = createDefaultConfig();

  if ('detection' in raw) {
    const detection = expectObject(raw.detection, 'detection');

    if ('patterns' in detection) {
      config.detection.patterns = expectBoolean(detection.patterns, 'detection.patterns');
    }

    if ('context' in detection) {
      config.detection.context = expectBoolean(detection.context, 'detection.context');
    }

    if ('entropy' in detection) {
      config.detection.entropy = expectBoolean(detection.entropy, 'detection.entropy');
    }

    if ('entropyThreshold' in detection) {
      config.detection.entropyThreshold = expectFiniteNumber(
        detection.entropyThreshold,
        'detection.entropyThreshold',
      );
    }
  }

  if ('ais' in raw) {
    const ais = expectObject(raw.ais, 'ais');

    if ('recentLimit' in ais) {
      config.ais.recentLimit = expectPositiveInteger(ais.recentLimit, 'ais.recentLimit');
    }

    if ('statePath' in ais) {
      config.ais.statePath = expectString(ais.statePath, 'ais.statePath');
    }
  }

  if ('display' in raw) {
    const display = expectObject(raw.display, 'display');

    if ('debug' in display) {
      config.display.debug = expectBoolean(display.debug, 'display.debug');
    }
  }

  if ('storage' in raw) {
    const storage = expectObject(raw.storage, 'storage');

    if ('persistSecrets' in storage) {
      config.storage.persistSecrets = expectBoolean(storage.persistSecrets, 'storage.persistSecrets');
    }

    if ('vaultPath' in storage) {
      config.storage.vaultPath = expectString(storage.vaultPath, 'storage.vaultPath');
    }
  }

  if ('customPatterns' in raw) {
    if (!Array.isArray(raw.customPatterns)) {
      throw new Error('Failed to load config: customPatterns must be an array');
    }

    config.customPatterns = raw.customPatterns.map((value, index) => parseCustomPattern(value, index));
  }

  return config;
}

function parseCustomPattern(value: unknown, index: number): CustomPatternConfig {
  const pattern = expectObject(value, `customPatterns[${index}]`);
  const id = expectString(pattern.id, `customPatterns[${index}].id`);
  const regex = expectString(pattern.regex, `customPatterns[${index}].regex`);
  const type = expectString(pattern.type, `customPatterns[${index}].type`);

  if (!isSecretType(type)) {
    throw new Error(`Failed to load config: customPatterns[${index}].type is invalid`);
  }

  try {
    new RegExp(regex, 'g');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load config: customPatterns[${index}].regex is invalid: ${message}`);
  }

  return {
    id,
    regex,
    type,
  };
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Failed to load config: ${path} must be a boolean`);
  }

  return value;
}

function expectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Failed to load config: ${path} must be a finite number`);
  }

  return value;
}

function expectPositiveInteger(value: unknown, path: string): number {
  const parsed = expectFiniteNumber(value, path);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Failed to load config: ${path} must be a positive integer`);
  }

  return parsed;
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Failed to load config: ${path} must be an object`);
  }

  return value;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Failed to load config: ${path} must be a string`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
