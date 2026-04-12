import { chmodSync, existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  PROTECT_TOOLS,
  isProtectTool,
  isUpdateChannel,
  type ProtectTool,
  type UpdateChannel,
} from './model.js';

const STATE_FILE_MODE = 0o600;

export const DEFAULT_AUTOMATION_STATE_PATH_DISPLAY = '~/.ais/automation-state.json';

export type UpdateCheckResult =
  | 'available'
  | 'failed'
  | 'never'
  | 'skipped'
  | 'up-to-date'
  | 'updated';

export interface ProtectToolRuntimeState {
  backupPath?: string;
  installed: boolean;
  lastChangedAt?: number;
  lastError?: string;
  managedPath?: string;
  originalCommandPath?: string;
  suspended: boolean;
}

export interface AutomationState {
  protect: {
    tools: Record<ProtectTool, ProtectToolRuntimeState>;
  };
  update: {
    lastChannel?: UpdateChannel;
    lastCheckedAt?: number;
    lastError?: string;
    lastLocalVersion?: string;
    lastRemoteVersion?: string;
    lastResult: UpdateCheckResult;
    skipNextCheck: boolean;
  };
}

export interface LoadedAutomationState {
  exists: boolean;
  path: string;
  recoveredFrom?: string;
  recoveryReason?: string;
  state: AutomationState;
}

export function createDefaultAutomationState(): AutomationState {
  return {
    protect: {
      tools: Object.fromEntries(
        PROTECT_TOOLS.map((tool) => [tool, createDefaultProtectToolRuntimeState()]),
      ) as Record<ProtectTool, ProtectToolRuntimeState>,
    },
    update: {
      lastResult: 'never',
      skipNextCheck: false,
    },
  };
}

export function createDefaultProtectToolRuntimeState(): ProtectToolRuntimeState {
  return {
    installed: false,
    suspended: false,
  };
}

export function resolveAutomationStatePath(path?: string): string {
  return expandHomePath(path ?? DEFAULT_AUTOMATION_STATE_PATH_DISPLAY);
}

export async function loadAutomationState(path?: string): Promise<LoadedAutomationState> {
  const resolvedPath = resolveAutomationStatePath(path);

  if (!existsSync(resolvedPath)) {
    return {
      exists: false,
      path: resolvedPath,
      state: createDefaultAutomationState(),
    };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(resolvedPath, 'utf8'));
  } catch (error) {
    return recoverAutomationState(resolvedPath, error);
  }

  try {
    return {
      exists: true,
      path: resolvedPath,
      state: mergeAutomationState(parsed),
    };
  } catch (error) {
    return recoverAutomationState(resolvedPath, error);
  }
}

export async function saveAutomationState(state: AutomationState, path?: string): Promise<void> {
  const resolvedPath = resolveAutomationStatePath(path);
  const payload = `${JSON.stringify(state, null, 2)}\n`;

  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, payload, { mode: STATE_FILE_MODE });
  chmodSync(resolvedPath, STATE_FILE_MODE);
}

export function clearProtectRuntimeState(
  state: AutomationState,
  tool?: ProtectTool,
  now = Date.now(),
): AutomationState {
  const next = cloneAutomationState(state);
  const targets = tool ? [tool] : PROTECT_TOOLS;

  for (const currentTool of targets) {
    next.protect.tools[currentTool] = {
      ...createDefaultProtectToolRuntimeState(),
      lastChangedAt: now,
    };
  }

  return next;
}

export function cloneAutomationState(state: AutomationState): AutomationState {
  return {
    protect: {
      tools: Object.fromEntries(
        PROTECT_TOOLS.map((tool) => [
          tool,
          {
            ...state.protect.tools[tool],
          },
        ]),
      ) as Record<ProtectTool, ProtectToolRuntimeState>,
    },
    update: {
      ...state.update,
    },
  };
}

function mergeAutomationState(raw: unknown): AutomationState {
  if (!isRecord(raw)) {
    throw new Error('Failed to load automation state: root must be an object');
  }

  const state = createDefaultAutomationState();

  if ('update' in raw) {
    const update = expectObject(raw.update, 'update');

    if ('lastResult' in update) {
      state.update.lastResult = expectUpdateCheckResult(update.lastResult, 'update.lastResult');
    }

    if ('skipNextCheck' in update) {
      state.update.skipNextCheck = expectBoolean(update.skipNextCheck, 'update.skipNextCheck');
    }

    if ('lastCheckedAt' in update) {
      state.update.lastCheckedAt = expectOptionalFiniteNumber(update.lastCheckedAt, 'update.lastCheckedAt');
    }

    if ('lastChannel' in update) {
      state.update.lastChannel = expectOptionalUpdateChannel(update.lastChannel, 'update.lastChannel');
    }

    if ('lastLocalVersion' in update) {
      state.update.lastLocalVersion = expectOptionalString(update.lastLocalVersion, 'update.lastLocalVersion');
    }

    if ('lastRemoteVersion' in update) {
      state.update.lastRemoteVersion = expectOptionalString(update.lastRemoteVersion, 'update.lastRemoteVersion');
    }

    if ('lastError' in update) {
      state.update.lastError = expectOptionalString(update.lastError, 'update.lastError');
    }
  }

  if ('protect' in raw) {
    const protect = expectObject(raw.protect, 'protect');
    if ('tools' in protect) {
      const tools = expectObject(protect.tools, 'protect.tools');
      for (const [key, value] of Object.entries(tools)) {
        if (!isProtectTool(key)) {
          throw new Error(`Failed to load automation state: protect.tools.${key} is not supported`);
        }

        state.protect.tools[key] = parseProtectToolRuntimeState(value, `protect.tools.${key}`);
      }
    }
  }

  return state;
}

function parseProtectToolRuntimeState(value: unknown, path: string): ProtectToolRuntimeState {
  const toolState = expectObject(value, path);
  const parsed = createDefaultProtectToolRuntimeState();

  if ('installed' in toolState) {
    parsed.installed = expectBoolean(toolState.installed, `${path}.installed`);
  }

  if ('suspended' in toolState) {
    parsed.suspended = expectBoolean(toolState.suspended, `${path}.suspended`);
  }

  if ('managedPath' in toolState) {
    parsed.managedPath = expectOptionalString(toolState.managedPath, `${path}.managedPath`);
  }

  if ('backupPath' in toolState) {
    parsed.backupPath = expectOptionalString(toolState.backupPath, `${path}.backupPath`);
  }

  if ('originalCommandPath' in toolState) {
    parsed.originalCommandPath = expectOptionalString(
      toolState.originalCommandPath,
      `${path}.originalCommandPath`,
    );
  }

  if ('lastError' in toolState) {
    parsed.lastError = expectOptionalString(toolState.lastError, `${path}.lastError`);
  }

  if ('lastChangedAt' in toolState) {
    parsed.lastChangedAt = expectOptionalFiniteNumber(toolState.lastChangedAt, `${path}.lastChangedAt`);
  }

  return parsed;
}

async function recoverAutomationState(path: string, error: unknown): Promise<LoadedAutomationState> {
  const message = error instanceof Error ? error.message : String(error);
  const backupPath = `${path}.corrupt-${Date.now()}`;

  let recoveredFrom: string | undefined;
  try {
    await rename(path, backupPath);
    recoveredFrom = backupPath;
  } catch {
    recoveredFrom = path;
  }

  return {
    exists: false,
    path,
    recoveredFrom,
    recoveryReason: message,
    state: createDefaultAutomationState(),
  };
}

function expectUpdateCheckResult(value: unknown, path: string): UpdateCheckResult {
  if (
    value !== 'available' &&
    value !== 'failed' &&
    value !== 'never' &&
    value !== 'skipped' &&
    value !== 'up-to-date' &&
    value !== 'updated'
  ) {
    throw new Error(`Failed to load automation state: ${path} must be a valid update result`);
  }

  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Failed to load automation state: ${path} must be a boolean`);
  }

  return value;
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Failed to load automation state: ${path} must be an object`);
  }

  return value;
}

function expectOptionalFiniteNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Failed to load automation state: ${path} must be a finite number`);
  }

  return value;
}

function expectOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`Failed to load automation state: ${path} must be a string`);
  }

  return value;
}

function expectOptionalUpdateChannel(value: unknown, path: string): UpdateChannel | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !isUpdateChannel(value)) {
    throw new Error(`Failed to load automation state: ${path} must be one of ${UPDATE_CHANNELS_LABEL}`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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

const UPDATE_CHANNELS_LABEL = 'latest, next';
