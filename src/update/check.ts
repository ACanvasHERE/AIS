import { cloneAutomationState, type AutomationState, type UpdateChannel } from '../automation/index.js';
import type { PackageInfo } from '../package-info.js';

const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org';
const UPDATE_CHECK_TIMEOUT_MS = 1500;
const SEMVER_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export interface UpdateCheckSettings {
  channel: UpdateChannel;
  checkIntervalMinutes: number;
  enabled: boolean;
  forceCheck?: boolean;
  silent: boolean;
  skipCheck: boolean;
}

export interface MaybeCheckForUpdatesOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  packageInfo: PackageInfo;
}

export interface UpdateCheckOutcome {
  changed: boolean;
  message?: string;
  state: AutomationState;
}

interface RegistryManifest {
  'dist-tags': Record<string, unknown>;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<number | string>;
}

export async function maybeCheckForUpdates(
  state: AutomationState,
  settings: UpdateCheckSettings,
  options: MaybeCheckForUpdatesOptions,
): Promise<UpdateCheckOutcome> {
  const now = (options.now ?? Date.now)();
  const nextState = cloneAutomationState(state);
  const { packageInfo } = options;

  nextState.update.lastChannel = settings.channel;
  nextState.update.lastLocalVersion = packageInfo.version;

  if (!settings.enabled) {
    nextState.update.lastResult = 'skipped';
    nextState.update.lastError = undefined;
    return buildOutcome(state, nextState);
  }

  if (settings.skipCheck) {
    nextState.update.lastResult = 'skipped';
    nextState.update.lastError = undefined;
    return buildOutcome(state, nextState);
  }

  if (nextState.update.skipNextCheck) {
    nextState.update.lastResult = 'skipped';
    nextState.update.lastError = undefined;
    nextState.update.skipNextCheck = false;
    return buildOutcome(state, nextState);
  }

  if (!settings.forceCheck && shouldThrottle(state, settings, packageInfo.version, now)) {
    return buildOutcome(state, nextState);
  }

  try {
    const remoteVersion = await fetchRemoteVersion(settings.channel, options.fetchImpl ?? fetch, options);
    nextState.update.lastCheckedAt = now;
    nextState.update.lastError = undefined;
    nextState.update.lastRemoteVersion = remoteVersion;
    nextState.update.lastResult = compareVersions(remoteVersion, packageInfo.version) > 0 ? 'available' : 'up-to-date';

    const message =
      nextState.update.lastResult === 'available'
        ? formatUpdateAvailableMessage(packageInfo.name, packageInfo.version, remoteVersion, settings.channel)
        : settings.silent
          ? undefined
          : formatUpToDateMessage(packageInfo.version, settings.channel);

    return buildOutcome(state, nextState, message);
  } catch (error) {
    nextState.update.lastCheckedAt = now;
    nextState.update.lastError = toErrorMessage(error);
    nextState.update.lastRemoteVersion = undefined;
    nextState.update.lastResult = 'failed';

    return buildOutcome(
      state,
      nextState,
      settings.silent ? undefined : formatFailureMessage(nextState.update.lastError),
    );
  }
}

export function compareVersions(left: string, right: string): number {
  const leftVersion = parseSemver(left);
  const rightVersion = parseSemver(right);

  if (leftVersion.major !== rightVersion.major) {
    return leftVersion.major - rightVersion.major;
  }

  if (leftVersion.minor !== rightVersion.minor) {
    return leftVersion.minor - rightVersion.minor;
  }

  if (leftVersion.patch !== rightVersion.patch) {
    return leftVersion.patch - rightVersion.patch;
  }

  if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length === 0) {
    return 0;
  }

  if (leftVersion.prerelease.length === 0) {
    return 1;
  }

  if (rightVersion.prerelease.length === 0) {
    return -1;
  }

  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftVersion.prerelease[index];
    const rightIdentifier = rightVersion.prerelease[index];

    if (leftIdentifier === undefined) {
      return -1;
    }

    if (rightIdentifier === undefined) {
      return 1;
    }

    if (leftIdentifier === rightIdentifier) {
      continue;
    }

    const leftIsNumber = typeof leftIdentifier === 'number';
    const rightIsNumber = typeof rightIdentifier === 'number';

    if (leftIsNumber && rightIsNumber) {
      return leftIdentifier - rightIdentifier;
    }

    if (leftIsNumber) {
      return -1;
    }

    if (rightIsNumber) {
      return 1;
    }

    return leftIdentifier.localeCompare(rightIdentifier);
  }

  return 0;
}

async function fetchRemoteVersion(
  channel: UpdateChannel,
  fetchImpl: typeof fetch,
  options: MaybeCheckForUpdatesOptions,
): Promise<string> {
  const response = await fetchWithTimeout(fetchImpl, buildRegistryUrl(options.packageInfo.name, options.env));
  const payload = (await response.json()) as unknown;
  const manifest = parseRegistryManifest(payload);
  const version = manifest['dist-tags'][channel];

  if (typeof version !== 'string' || version.trim().length === 0) {
    throw new Error(`registry did not return a version for channel "${channel}"`);
  }

  parseSemver(version);
  return version;
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);

  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`registry responded with ${response.status}`);
    }

    return response;
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`timed out after ${UPDATE_CHECK_TIMEOUT_MS}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildRegistryUrl(packageName: string, env?: NodeJS.ProcessEnv): string {
  const base = normalizeRegistryBase(env?.npm_config_registry ?? env?.NPM_CONFIG_REGISTRY ?? DEFAULT_REGISTRY_URL);
  return new URL(encodeURIComponent(packageName), base).toString();
}

function normalizeRegistryBase(input: string): string {
  return input.endsWith('/') ? input : `${input}/`;
}

function parseRegistryManifest(value: unknown): RegistryManifest {
  if (!isRecord(value)) {
    throw new Error('registry response root must be an object');
  }

  if (!isRecord(value['dist-tags'])) {
    throw new Error('registry response dist-tags must be an object');
  }

  return {
    'dist-tags': value['dist-tags'],
  };
}

function parseSemver(version: string): ParsedSemver {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) {
    throw new Error(`invalid version: ${version}`);
  }

  const prerelease = match[4]
    ? match[4].split('.').map((identifier) => (/^\d+$/.test(identifier) ? Number.parseInt(identifier, 10) : identifier))
    : [];

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease,
  };
}

function shouldThrottle(
  state: AutomationState,
  settings: UpdateCheckSettings,
  currentVersion: string,
  now: number,
): boolean {
  if (state.update.lastCheckedAt === undefined) {
    return false;
  }

  if (state.update.lastChannel !== settings.channel) {
    return false;
  }

  if (state.update.lastLocalVersion !== currentVersion) {
    return false;
  }

  const intervalMs = settings.checkIntervalMinutes * 60_000;
  return now - state.update.lastCheckedAt < intervalMs;
}

function buildOutcome(previousState: AutomationState, nextState: AutomationState, message?: string): UpdateCheckOutcome {
  return {
    changed: JSON.stringify(previousState) !== JSON.stringify(nextState),
    message,
    state: nextState,
  };
}

function formatUpdateAvailableMessage(
  packageName: string,
  localVersion: string,
  remoteVersion: string,
  channel: UpdateChannel,
): string {
  return `Update available: ${packageName}@${remoteVersion} on ${channel}. Continuing with ${localVersion}. Install manually for now: npm install -g ${packageName}@${remoteVersion}`;
}

function formatUpToDateMessage(localVersion: string, channel: UpdateChannel): string {
  return `Update check: already on ${localVersion} for channel ${channel}.`;
}

function formatFailureMessage(errorMessage: string): string {
  return `Update check failed, continuing without update: ${errorMessage}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
