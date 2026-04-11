export const SECRET_TYPES = [
  'PASSWORD',
  'APIKEY',
  'DBCONN',
  'PRIVATE_KEY',
  'BEARER_TOKEN',
  'JWT',
  'GENERIC',
] as const;

export type SecretType = (typeof SECRET_TYPES)[number];

export const SECRET_SOURCES = ['manual', 'argv', 'stdin', 'proxy'] as const;

export type SecretSource = (typeof SECRET_SOURCES)[number];

export interface VaultEntry {
  token: string;
  secret: string;
  type: SecretType;
  createdAt: number;
  hitCount: number;
  name?: string;
  source?: SecretSource;
}

export type TokenGenerator = (
  secret: string,
  type: SecretType,
  sessionId: string,
) => string;

export function isSecretType(value: unknown): value is SecretType {
  return typeof value === 'string' && SECRET_TYPES.includes(value as SecretType);
}

export function isSecretSource(value: unknown): value is SecretSource {
  return typeof value === 'string' && SECRET_SOURCES.includes(value as SecretSource);
}
