import { readFileSync } from 'node:fs';

export interface PackageInfo {
  name: string;
  version: string;
}

let cachedPackageInfo: PackageInfo | undefined;

export function getPackageInfo(): PackageInfo {
  if (cachedPackageInfo) {
    return cachedPackageInfo;
  }

  cachedPackageInfo = readPackageInfo();
  return cachedPackageInfo;
}

export const PACKAGE_NAME = getPackageInfo().name;
export const VERSION = getPackageInfo().version;

function readPackageInfo(): PackageInfo {
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  } catch (error) {
    throw new Error(`Failed to load package info: ${toErrorMessage(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error('Failed to load package info: package.json root must be an object');
  }

  return {
    name: expectString(parsed.name, 'name'),
    version: expectString(parsed.version, 'version'),
  };
}

function expectString(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Failed to load package info: package.json ${key} must be a non-empty string`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
