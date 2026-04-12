import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cloneAutomationState, type AutomationState } from '../automation/index.js';
import { maybeCheckForUpdates, type MaybeCheckForUpdatesOptions, type UpdateCheckSettings } from './check.js';

const NPM_COMMAND = 'npm';
const UPDATE_LOCK_STALE_MS = 30 * 60_000;

export interface UpdateCommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export type UpdateCommandRunner = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
) => Promise<UpdateCommandResult>;

export interface SelfUpdateOptions extends MaybeCheckForUpdatesOptions {
  automationStatePath: string;
  commandRunner?: UpdateCommandRunner;
  currentPackageRoot?: string;
}

export interface SelfUpdateOutcome {
  changed: boolean;
  message?: string;
  state: AutomationState;
  status: 'available' | 'failed' | 'locked' | 'skipped' | 'up-to-date' | 'updated';
}

interface InstallPaths {
  binPath: string;
  currentPackageRoot: string;
  globalPackageRoot: string;
}

interface UpdateLockPayload {
  packageName: string;
  pid: number;
  remoteVersion: string;
  startedAt: number;
}

interface HeldLock {
  release(): Promise<void>;
}

type BinBackup =
  | { contents: Buffer; kind: 'file'; mode: number; originalPath: string }
  | { kind: 'missing'; originalPath: string }
  | { kind: 'symlink'; originalPath: string; target: string };

interface InstallBackup {
  bin: BinBackup;
  packageBackupPath: string;
}

export async function maybeRunStartupSelfUpdate(
  state: AutomationState,
  settings: UpdateCheckSettings,
  options: SelfUpdateOptions,
): Promise<SelfUpdateOutcome> {
  const check = await maybeCheckForUpdates(state, settings, options);

  if (check.state.update.lastResult !== 'available' || !check.state.update.lastRemoteVersion) {
    return {
      changed: check.changed,
      message: check.message,
      state: check.state,
      status: normalizeStatus(check.state.update.lastResult),
    };
  }

  return applyAvailableUpdate(state, check.state, options, {
    localVersion: options.packageInfo.version,
    packageName: options.packageInfo.name,
    remoteVersion: check.state.update.lastRemoteVersion,
  });
}

export async function runManualSelfUpdate(
  state: AutomationState,
  settings: Pick<UpdateCheckSettings, 'channel'>,
  options: SelfUpdateOptions,
): Promise<SelfUpdateOutcome> {
  const check = await maybeCheckForUpdates(
    state,
    {
      channel: settings.channel,
      checkIntervalMinutes: 0,
      enabled: true,
      forceCheck: true,
      silent: false,
      skipCheck: false,
    },
    options,
  );

  if (check.state.update.lastResult !== 'available' || !check.state.update.lastRemoteVersion) {
    return {
      changed: check.changed,
      message: check.message,
      state: check.state,
      status: normalizeStatus(check.state.update.lastResult),
    };
  }

  return applyAvailableUpdate(state, check.state, options, {
    localVersion: options.packageInfo.version,
    packageName: options.packageInfo.name,
    remoteVersion: check.state.update.lastRemoteVersion,
  });
}

export function resolveUpdateLockPath(automationStatePath: string): string {
  return `${automationStatePath}.update.lock`;
}

export function resolveCurrentPackageRootFromUrl(moduleUrl: string, packageName: string): string {
  let currentDirectory = dirname(fileURLToPath(moduleUrl));

  for (let depth = 0; depth < 8; depth += 1) {
    const packageJsonPath = join(currentDirectory, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as unknown;
        if (isRecord(parsed) && parsed.name === packageName) {
          return currentDirectory;
        }
      } catch {
        // 包描述损坏时继续往上找，直到命中正确的包根目录。
      }
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      break;
    }
    currentDirectory = parentDirectory;
  }

  throw new Error(`current package root could not be resolved for ${packageName}`);
}

async function applyAvailableUpdate(
  previousState: AutomationState,
  checkedState: AutomationState,
  options: SelfUpdateOptions,
  update: {
    localVersion: string;
    packageName: string;
    remoteVersion: string;
  },
): Promise<SelfUpdateOutcome> {
  const now = (options.now ?? Date.now)();
  const lock = await acquireLock(resolveUpdateLockPath(options.automationStatePath), {
    packageName: update.packageName,
    pid: process.pid,
    remoteVersion: update.remoteVersion,
    startedAt: now,
  });

  if (!lock) {
    return {
      changed: hasStateChanged(previousState, checkedState),
      message: formatLockedMessage(update.packageName, update.localVersion, update.remoteVersion),
      state: checkedState,
      status: 'locked',
    };
  }

  let backup: InstallBackup | undefined;
  try {
    const runner = options.commandRunner ?? runUpdateCommand;
    const installPaths = await resolveInstallPaths(update.packageName, runner, options);

    if (installPaths.currentPackageRoot !== installPaths.globalPackageRoot) {
      return {
        changed: hasStateChanged(previousState, checkedState),
        message: formatUnsupportedInstallMessage(update.packageName, update.localVersion, update.remoteVersion),
        state: checkedState,
        status: 'skipped',
      };
    }

    backup = await createInstallBackup(installPaths, dirname(options.automationStatePath), update.packageName);

    const installResult = await runner(
      NPM_COMMAND,
      ['install', '-g', `${update.packageName}@${update.remoteVersion}`, '--loglevel=error', '--fund=false', '--audit=false'],
      {
        env: options.env,
      },
    );

    if (installResult.exitCode !== 0) {
      return await finalizeFailedInstall(previousState, checkedState, installPaths, backup, update, installResult);
    }

    const installedVersion = await readInstalledVersion(installPaths.globalPackageRoot);
    if (installedVersion !== update.remoteVersion) {
      return await finalizeFailedInstall(previousState, checkedState, installPaths, backup, update, {
        exitCode: 1,
        stderr: `installed version mismatch: expected ${update.remoteVersion}, got ${installedVersion}`,
        stdout: '',
      });
    }

    const nextState = cloneAutomationState(checkedState);
    nextState.update.lastError = undefined;
    nextState.update.lastLocalVersion = update.remoteVersion;
    nextState.update.lastRemoteVersion = update.remoteVersion;
    nextState.update.lastResult = 'updated';

    return {
      changed: hasStateChanged(previousState, nextState),
      message: formatSuccessMessage(update.packageName, update.localVersion, update.remoteVersion),
      state: nextState,
      status: 'updated',
    };
  } catch (error) {
    const nextState = cloneAutomationState(checkedState);
    nextState.update.lastError = toErrorMessage(error);
    nextState.update.lastLocalVersion = update.localVersion;
    nextState.update.lastRemoteVersion = update.remoteVersion;
    nextState.update.lastResult = 'failed';

    return {
      changed: hasStateChanged(previousState, nextState),
      message: formatFailureMessage(update.packageName, update.localVersion, update.remoteVersion, toErrorMessage(error)),
      state: nextState,
      status: 'failed',
    };
  } finally {
    await lock.release();
    if (backup) {
      await rm(backup.packageBackupPath, { force: true, recursive: true });
    }
  }
}

async function finalizeFailedInstall(
  previousState: AutomationState,
  checkedState: AutomationState,
  installPaths: InstallPaths,
  backup: InstallBackup,
  update: {
    localVersion: string;
    packageName: string;
    remoteVersion: string;
  },
  installResult: UpdateCommandResult,
): Promise<SelfUpdateOutcome> {
  const installError = extractCommandError(installResult);
  const restoreNeeded = !(await isCurrentInstallHealthy(installPaths, backup, update.localVersion));

  let restoreMessage = 'previous installation kept intact';
  let combinedError = installError;

  if (restoreNeeded) {
    try {
      await restoreInstallBackup(installPaths, backup);
      restoreMessage = 'restored previous installation';
    } catch (restoreError) {
      const restoreText = toErrorMessage(restoreError);
      restoreMessage = `restore attempt failed: ${restoreText}`;
      combinedError = `${installError}; restore failed: ${restoreText}`;
    }
  }

  const nextState = cloneAutomationState(checkedState);
  nextState.update.lastError = combinedError;
  nextState.update.lastLocalVersion = update.localVersion;
  nextState.update.lastRemoteVersion = update.remoteVersion;
  nextState.update.lastResult = 'failed';

  return {
    changed: hasStateChanged(previousState, nextState),
    message: formatInstallFailureMessage(update.packageName, update.localVersion, update.remoteVersion, combinedError, restoreMessage),
    state: nextState,
    status: 'failed',
  };
}

async function resolveInstallPaths(
  packageName: string,
  runner: UpdateCommandRunner,
  options: SelfUpdateOptions,
): Promise<InstallPaths> {
  const globalRootOutput = await runCommandOrThrow(runner, NPM_COMMAND, ['root', '-g'], options.env);
  const globalPrefixOutput = await runCommandOrThrow(runner, NPM_COMMAND, ['prefix', '-g'], options.env);

  const globalNodeModulesRoot = requireTrimmedOutput(globalRootOutput, 'npm root -g');
  const globalPrefix = requireTrimmedOutput(globalPrefixOutput, 'npm prefix -g');
  const currentPackageRoot = options.currentPackageRoot ?? resolveCurrentPackageRootFromUrl(import.meta.url, packageName);

  return {
    binPath: resolve(globalPrefix, 'bin', getBinName(packageName)),
    currentPackageRoot: await normalizePath(currentPackageRoot),
    globalPackageRoot: await normalizePath(join(globalNodeModulesRoot, ...packageName.split('/'))),
  };
}

async function createInstallBackup(
  installPaths: InstallPaths,
  backupBaseDirectory: string,
  packageName: string,
): Promise<InstallBackup> {
  if (!existsSync(installPaths.globalPackageRoot)) {
    throw new Error(`installed package path not found: ${installPaths.globalPackageRoot}`);
  }

  const backupDirectory = join(backupBaseDirectory, '.ais-update-backups');
  await mkdir(backupDirectory, { recursive: true });

  const packageBackupPath = join(backupDirectory, `${getBinName(packageName)}-${Date.now()}.tar`);
  await archiveDirectory(installPaths.globalPackageRoot, packageBackupPath);

  return {
    bin: await backupBinPath(installPaths.binPath),
    packageBackupPath,
  };
}

async function backupBinPath(binPath: string): Promise<BinBackup> {
  if (!(await pathExists(binPath))) {
    return {
      kind: 'missing',
      originalPath: binPath,
    };
  }

  const stats = await lstat(binPath);
  if (stats.isSymbolicLink()) {
    return {
      kind: 'symlink',
      originalPath: binPath,
      target: await readlink(binPath),
    };
  }

  return {
    contents: await readFile(binPath),
    kind: 'file',
    mode: stats.mode,
    originalPath: binPath,
  };
}

async function restoreInstallBackup(installPaths: InstallPaths, backup: InstallBackup): Promise<void> {
  await rm(installPaths.globalPackageRoot, { force: true, recursive: true });
  await mkdir(dirname(installPaths.globalPackageRoot), { recursive: true });
  await extractArchive(backup.packageBackupPath, dirname(installPaths.globalPackageRoot));
  await restoreBinPath(backup.bin);
}

async function restoreBinPath(backup: BinBackup): Promise<void> {
  switch (backup.kind) {
    case 'missing':
      await rm(backup.originalPath, { force: true, recursive: true });
      return;

    case 'symlink':
      await rm(backup.originalPath, { force: true, recursive: true });
      await mkdir(dirname(backup.originalPath), { recursive: true });
      await symlink(backup.target, backup.originalPath);
      return;

    case 'file':
      await rm(backup.originalPath, { force: true, recursive: true });
      await mkdir(dirname(backup.originalPath), { recursive: true });
      await writeFile(backup.originalPath, backup.contents);
      await chmod(backup.originalPath, backup.mode);
      return;
  }
}

async function isCurrentInstallHealthy(
  installPaths: InstallPaths,
  backup: InstallBackup,
  expectedVersion: string,
): Promise<boolean> {
  try {
    const currentVersion = await readInstalledVersion(installPaths.globalPackageRoot);
    if (currentVersion !== expectedVersion) {
      return false;
    }
  } catch {
    return false;
  }

  if (backup.bin.kind === 'missing') {
    return !(await pathExists(installPaths.binPath));
  }

  return pathExists(installPaths.binPath);
}

async function readInstalledVersion(packageRoot: string): Promise<string> {
  const raw = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as unknown;
  if (!isRecord(raw) || typeof raw.version !== 'string' || raw.version.trim().length === 0) {
    throw new Error(`package.json at ${packageRoot} does not contain a valid version`);
  }

  return raw.version;
}

async function acquireLock(lockPath: string, payload: UpdateLockPayload): Promise<HeldLock | undefined> {
  const directory = dirname(lockPath);
  await mkdir(directory, { recursive: true });

  const stale = await shouldTreatLockAsStale(lockPath, payload.startedAt);
  if (stale) {
    await rm(lockPath, { force: true });
  }

  try {
    const handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`);
    await handle.close();

    return {
      async release() {
        await rm(lockPath, { force: true });
      },
    };
  } catch (error) {
    if (isFileExistsError(error)) {
      return undefined;
    }

    throw error;
  }
}

async function shouldTreatLockAsStale(lockPath: string, now: number): Promise<boolean> {
  if (!(await pathExists(lockPath))) {
    return false;
  }

  try {
    const payload = JSON.parse(await readFile(lockPath, 'utf8')) as unknown;
    if (!isRecord(payload)) {
      return true;
    }

    const startedAt = typeof payload.startedAt === 'number' ? payload.startedAt : undefined;
    const pid = typeof payload.pid === 'number' ? payload.pid : undefined;

    if (startedAt === undefined || now - startedAt > UPDATE_LOCK_STALE_MS) {
      return true;
    }

    if (pid === undefined) {
      return true;
    }

    return !isProcessAlive(pid);
  } catch {
    return true;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function normalizePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function archiveDirectory(sourcePath: string, archivePath: string): Promise<void> {
  await runCommandOrThrow(runUpdateCommand, 'tar', ['-cf', archivePath, '-C', dirname(sourcePath), basename(sourcePath)]);
}

async function extractArchive(archivePath: string, destinationDirectory: string): Promise<void> {
  await runCommandOrThrow(runUpdateCommand, 'tar', ['-xf', archivePath, '-C', destinationDirectory]);
}

async function runCommandOrThrow(
  runner: UpdateCommandRunner,
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await runner(command, args, { env });
  if (result.exitCode !== 0) {
    throw new Error(extractCommandError(result));
  }

  return result.stdout;
}

function requireTrimmedOutput(output: string, commandLabel: string): string {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    throw new Error(`${commandLabel} returned an empty response`);
  }

  return trimmed;
}

async function runUpdateCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<UpdateCommandResult> {
  return new Promise<UpdateCommandResult>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });

    child.on('error', rejectPromise);
    child.on('close', (exitCode) => {
      resolvePromise({
        exitCode: exitCode ?? 1,
        stderr,
        stdout,
      });
    });
  });
}

function normalizeStatus(result: AutomationState['update']['lastResult']): SelfUpdateOutcome['status'] {
  switch (result) {
    case 'updated':
      return 'updated';
    case 'up-to-date':
      return 'up-to-date';
    case 'failed':
      return 'failed';
    case 'available':
      return 'available';
    default:
      return 'skipped';
  }
}

function hasStateChanged(previousState: AutomationState, nextState: AutomationState): boolean {
  return JSON.stringify(previousState) !== JSON.stringify(nextState);
}

function getBinName(packageName: string): string {
  const parts = packageName.split('/');
  return parts[parts.length - 1];
}

function formatLockedMessage(packageName: string, localVersion: string, remoteVersion: string): string {
  return `Update available: ${packageName}@${remoteVersion} is already being installed by another AIS process. Continuing with ${localVersion}.`;
}

function formatUnsupportedInstallMessage(packageName: string, localVersion: string, remoteVersion: string): string {
  return `Update available: ${packageName}@${remoteVersion}, but auto update only runs from the npm global installation. Continuing with ${localVersion}.`;
}

function formatSuccessMessage(packageName: string, localVersion: string, remoteVersion: string): string {
  return `Updated ${packageName} from ${localVersion} to ${remoteVersion}. Continuing this run with ${localVersion}; the new version will be used next time.`;
}

function formatFailureMessage(
  packageName: string,
  localVersion: string,
  remoteVersion: string,
  errorMessage: string,
): string {
  return `Update failed for ${packageName}@${remoteVersion}. Continuing with ${localVersion}: ${errorMessage}`;
}

function formatInstallFailureMessage(
  packageName: string,
  localVersion: string,
  remoteVersion: string,
  errorMessage: string,
  restoreMessage: string,
): string {
  return `Update failed for ${packageName}@${remoteVersion}. ${restoreMessage}; continuing with ${localVersion}. ${errorMessage}`;
}

function extractCommandError(result: UpdateCommandResult): string {
  const stderr = result.stderr.trim();
  if (stderr.length > 0) {
    return stderr;
  }

  const stdout = result.stdout.trim();
  if (stdout.length > 0) {
    return stdout;
  }

  return `command exited with ${result.exitCode}`;
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
