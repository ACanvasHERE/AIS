import { createHash } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  isSecretSource,
  isSecretType,
  type SecretSource,
  type SecretType,
} from '../vault/types.js';

const STATE_FILE_MODE = 0o600;

export const DEFAULT_AIS_STATE_PATH_DISPLAY = '~/.ais/ais-state.json';

export interface AisRecentRecord {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  name?: string;
  preview: string;
  seenCount: number;
  source: SecretSource;
  type: SecretType;
}

export interface AisState {
  excludedRecordIds: string[];
  excludedTypes: SecretType[];
  recentRecords: AisRecentRecord[];
}

export interface AisStoreOptions {
  path?: string;
  recentLimit?: number;
}

export interface RecordSecretOptions {
  name?: string;
  source: SecretSource;
  timestamp?: number;
}

export function createDefaultAisState(): AisState {
  return {
    excludedRecordIds: [],
    excludedTypes: [],
    recentRecords: [],
  };
}

export function buildAisRecordId(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 12);
}

export function resolveAisStatePath(path?: string): string {
  return expandHomePath(path ?? DEFAULT_AIS_STATE_PATH_DISPLAY);
}

export class AisStore {
  private dirty = false;
  private loaded = false;
  private state = createDefaultAisState();

  constructor(private readonly options: AisStoreOptions = {}) {}

  async load(): Promise<AisState> {
    if (this.loaded) {
      return this.getState();
    }

    const statePath = this.getPath();
    if (!existsSync(statePath)) {
      this.loaded = true;
      return this.getState();
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(await readFile(statePath, 'utf8'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load AIS state: ${message}`);
    }

    this.state = mergeAisState(parsed);
    this.loaded = true;
    return this.getState();
  }

  async save(): Promise<void> {
    if (!this.loaded || !this.dirty) {
      return;
    }

    const statePath = this.getPath();
    const payload = `${JSON.stringify(this.state, null, 2)}\n`;
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, payload, { mode: STATE_FILE_MODE });
    chmodSync(statePath, STATE_FILE_MODE);
    this.dirty = false;
  }

  getPath(): string {
    return resolveAisStatePath(this.options.path);
  }

  getState(): AisState {
    return {
      excludedRecordIds: [...this.state.excludedRecordIds],
      excludedTypes: [...this.state.excludedTypes],
      recentRecords: this.state.recentRecords.map((record) => ({ ...record })),
    };
  }

  isExcluded(secret: string, type: SecretType): boolean {
    this.assertLoaded();
    return this.state.excludedTypes.includes(type) || this.state.excludedRecordIds.includes(buildAisRecordId(secret));
  }

  recordSecret(secret: string, type: SecretType, options: RecordSecretOptions): AisRecentRecord {
    this.assertLoaded();
    const id = buildAisRecordId(secret);
    const timestamp = options.timestamp ?? Date.now();
    const preview = buildPreview(secret);
    const existing = this.state.recentRecords.find((record) => record.id === id);

    if (existing) {
      existing.lastSeenAt = timestamp;
      existing.seenCount += 1;
      existing.type = type;
      existing.source = options.source;
      existing.preview = preview;
      existing.name = normalizeName(options.name) ?? existing.name;
      this.sortRecentRecords();
      this.dirty = true;
      return { ...existing };
    }

    const record: AisRecentRecord = {
      id,
      createdAt: timestamp,
      lastSeenAt: timestamp,
      name: normalizeName(options.name),
      preview,
      seenCount: 1,
      source: options.source,
      type,
    };
    this.state.recentRecords.unshift(record);
    this.trimRecentRecords();
    this.sortRecentRecords();
    this.dirty = true;
    return { ...record };
  }

  setRecordExcluded(id: string, excluded: boolean): boolean {
    this.assertLoaded();
    const normalizedId = id.trim();
    if (!this.state.recentRecords.some((record) => record.id === normalizedId)) {
      return false;
    }

    const nextIds = new Set(this.state.excludedRecordIds);
    const hadValue = nextIds.has(normalizedId);
    if (excluded) {
      nextIds.add(normalizedId);
    } else {
      nextIds.delete(normalizedId);
    }

    if (hadValue === excluded) {
      return true;
    }

    this.state.excludedRecordIds = Array.from(nextIds).sort();
    this.dirty = true;
    return true;
  }

  setTypeExcluded(type: SecretType, excluded: boolean): void {
    this.assertLoaded();
    const nextTypes = new Set(this.state.excludedTypes);
    const hadValue = nextTypes.has(type);
    if (excluded) {
      nextTypes.add(type);
    } else {
      nextTypes.delete(type);
    }

    if (hadValue === excluded) {
      return;
    }

    this.state.excludedTypes = Array.from(nextTypes).sort();
    this.dirty = true;
  }

  private assertLoaded(): void {
    if (!this.loaded) {
      throw new Error('AIS state must be loaded before use.');
    }
  }

  private sortRecentRecords(): void {
    this.state.recentRecords.sort((left, right) => right.lastSeenAt - left.lastSeenAt);
  }

  private trimRecentRecords(): void {
    const recentLimit = Math.max(1, this.options.recentLimit ?? 20);
    if (this.state.recentRecords.length > recentLimit) {
      this.state.recentRecords.length = recentLimit;
    }
  }
}

function buildPreview(secret: string): string {
  const singleLine = secret.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= 6) {
    return `${singleLine.slice(0, 1)}***${singleLine.slice(-1)}`;
  }

  if (singleLine.length <= 12) {
    return `${singleLine.slice(0, 2)}***${singleLine.slice(-2)}`;
  }

  return `${singleLine.slice(0, 4)}***${singleLine.slice(-4)}`;
}

function mergeAisState(raw: unknown): AisState {
  if (!isRecord(raw)) {
    throw new Error('Failed to load AIS state: root must be an object');
  }

  const state = createDefaultAisState();

  if ('excludedRecordIds' in raw) {
    if (!Array.isArray(raw.excludedRecordIds) || !raw.excludedRecordIds.every((value) => typeof value === 'string')) {
      throw new Error('Failed to load AIS state: excludedRecordIds must be a string array');
    }

    state.excludedRecordIds = raw.excludedRecordIds.map((value) => value.trim()).filter(Boolean);
  }

  if ('excludedTypes' in raw) {
    if (!Array.isArray(raw.excludedTypes) || !raw.excludedTypes.every(isSecretType)) {
      throw new Error('Failed to load AIS state: excludedTypes must contain valid secret types');
    }

    state.excludedTypes = [...raw.excludedTypes];
  }

  if ('recentRecords' in raw) {
    if (!Array.isArray(raw.recentRecords)) {
      throw new Error('Failed to load AIS state: recentRecords must be an array');
    }

    state.recentRecords = raw.recentRecords.map((value, index) => parseRecentRecord(value, index));
  }

  return state;
}

function parseRecentRecord(value: unknown, index: number): AisRecentRecord {
  if (!isRecord(value)) {
    throw new Error(`Failed to load AIS state: recentRecords[${index}] must be an object`);
  }

  const id = expectString(value.id, `recentRecords[${index}].id`);
  const createdAt = expectNumber(value.createdAt, `recentRecords[${index}].createdAt`);
  const lastSeenAt = expectNumber(value.lastSeenAt, `recentRecords[${index}].lastSeenAt`);
  const preview = expectString(value.preview, `recentRecords[${index}].preview`);
  const seenCount = expectNumber(value.seenCount, `recentRecords[${index}].seenCount`);
  const source = expectSecretSource(value.source, `recentRecords[${index}].source`);
  const type = expectSecretType(value.type, `recentRecords[${index}].type`);

  return {
    id,
    createdAt,
    lastSeenAt,
    name: normalizeName(expectOptionalString(value.name, `recentRecords[${index}].name`)),
    preview,
    seenCount,
    source,
    type,
  };
}

function expectNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Failed to load AIS state: ${path} must be a finite number`);
  }

  return value;
}

function expectOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return expectString(value, path);
}

function expectSecretSource(value: unknown, path: string): SecretSource {
  if (!isSecretSource(value)) {
    throw new Error(`Failed to load AIS state: ${path} must be a valid source`);
  }

  return value;
}

function expectSecretType(value: unknown, path: string): SecretType {
  if (!isSecretType(value)) {
    throw new Error(`Failed to load AIS state: ${path} must be a valid type`);
  }

  return value;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Failed to load AIS state: ${path} must be a string`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeName(name: string | undefined): string | undefined {
  if (name === undefined) {
    return undefined;
  }

  const trimmed = name.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function getDefaultAisStatePath(baseDirectory = '~/.ais'): string {
  return join(baseDirectory, 'ais-state.json');
}

function expandHomePath(path: string): string {
  if (path === '~') {
    return homedir();
  }

  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }

  return path;
}
