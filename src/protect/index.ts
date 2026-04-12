import { spawn } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access, chmod, lstat, mkdir, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROTECT_TOOLS,
  cloneAutomationState,
  createDefaultProtectToolRuntimeState,
  type AutomationState,
  type ProtectTool,
  type ProtectToolRuntimeState,
} from '../automation/index.js';
import type { AisConfig } from '../config.js';

const EXECUTABLE_MODE = 0o755;
const MANAGED_WRAPPER_MARKER = '# AIS protect wrapper';
const SHELL_BLOCK_START = '# >>> AIS protect >>>';
const SHELL_BLOCK_END = '# <<< AIS protect <<<';

export interface ProtectShellCommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export type ProtectShellRunner = (
  command: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
  },
) => Promise<ProtectShellCommandResult>;

export interface ProtectRuntimeOptions {
  aisCliPath?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  nodePath?: string;
  now?: () => number;
  shellPath?: string;
  shellRunner?: ProtectShellRunner;
}

export interface ProtectSyncResult {
  changed: boolean;
  errors: string[];
  state: AutomationState;
  warnings: string[];
}

export interface ProtectRestoreResult extends ProtectSyncResult {
  config: AisConfig;
}

interface ProtectContext {
  aisCliPath: string;
  backupRootDir: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  managedBinDir: string;
  nodePath: string;
  now: () => number;
  shellPath?: string;
  shellRunner: ProtectShellRunner;
}

interface ToolCommandInfo {
  collision?: 'alias' | 'function';
  firstPath?: string;
  paths: string[];
}

interface ToolOperationResult {
  error?: string;
  runtime: ProtectToolRuntimeState;
  usesManagedBin: boolean;
  warning?: string;
}

export async function syncProtectRuntime(
  config: AisConfig,
  state: AutomationState,
  options: ProtectRuntimeOptions = {},
): Promise<ProtectSyncResult> {
  const context = createContext(options);
  const nextState = cloneAutomationState(state);
  const warnings: string[] = [];
  const errors: string[] = [];
  let managedBinNeeded = false;

  for (const tool of PROTECT_TOOLS) {
    const desired = config.protect.enabled && config.protect.tools[tool];
    const result = desired
      ? await installToolTakeover(tool, nextState.protect.tools[tool], context)
      : await removeToolTakeover(tool, nextState.protect.tools[tool], context, true);

    nextState.protect.tools[tool] = result.runtime;
    managedBinNeeded ||= result.usesManagedBin;
    if (result.warning) {
      warnings.push(result.warning);
    }
    if (result.error) {
      errors.push(result.error);
    }
  }

  const shellChanged = managedBinNeeded
    ? await ensureShellBlock(context)
    : await removeShellBlock(context);

  return {
    changed: shellChanged || hasStateChanged(state, nextState),
    errors,
    state: nextState,
    warnings,
  };
}

export async function refreshProtectRuntime(
  state: AutomationState,
  options: ProtectRuntimeOptions = {},
): Promise<ProtectSyncResult> {
  const context = createContext(options);
  const nextState = cloneAutomationState(state);
  const warnings: string[] = [];

  for (const tool of PROTECT_TOOLS) {
    const current = nextState.protect.tools[tool];
    const inspection = await inspectToolRuntime(tool, current, context);
    nextState.protect.tools[tool] = inspection.runtime;
    if (inspection.warning) {
      warnings.push(inspection.warning);
    }
  }

  return {
    changed: hasStateChanged(state, nextState),
    errors: [],
    state: nextState,
    warnings,
  };
}

export async function restoreProtectRuntime(
  config: AisConfig,
  state: AutomationState,
  options: ProtectRuntimeOptions = {},
): Promise<ProtectRestoreResult> {
  const context = createContext(options);
  const nextState = cloneAutomationState(state);
  const warnings: string[] = [];
  const errors: string[] = [];

  for (const tool of PROTECT_TOOLS) {
    const result = await removeToolTakeover(tool, nextState.protect.tools[tool], context, false);
    nextState.protect.tools[tool] = result.runtime;
    if (result.warning) {
      warnings.push(result.warning);
    }
    if (result.error) {
      errors.push(result.error);
    }
  }

  const shellChanged = await removeShellBlock(context);
  const nextConfig = structuredClone(config);
  nextConfig.protect.enabled = false;
  nextConfig.protect.tools.claude = false;
  nextConfig.protect.tools.codex = false;
  nextConfig.protect.tools.openclaw = false;

  return {
    changed: shellChanged || hasStateChanged(state, nextState) || JSON.stringify(config.protect) !== JSON.stringify(nextConfig.protect),
    config: nextConfig,
    errors,
    state: nextState,
    warnings,
  };
}

export async function resolveProtectedCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  options: Pick<ProtectRuntimeOptions, 'homeDir'> = {},
): Promise<string> {
  if (
    env.AIS_PROTECT_WRAPPER_ACTIVE !== '1' ||
    env.AIS_PROTECT_TOOL !== command ||
    !PROTECT_TOOLS.includes(command as ProtectTool)
  ) {
    return command;
  }

  const explicitCommand = env.AIS_PROTECT_REAL_COMMAND?.trim();
  const wrapperPath = env.AIS_PROTECT_WRAPPER_PATH?.trim();
  if (explicitCommand && explicitCommand !== wrapperPath && (await isExecutablePath(explicitCommand))) {
    return explicitCommand;
  }

  const homeDir = options.homeDir ?? env.HOME ?? homedir();
  const managedBinDir = env.AIS_PROTECT_WRAPPER_DIR?.trim() || join(homeDir, '.ais', 'bin');
  const found = await findCommandPaths(command as ProtectTool, env.PATH ?? process.env.PATH ?? '', {
    excludeDirs: [managedBinDir],
    excludePaths: wrapperPath ? [wrapperPath] : [],
  });

  if (found.paths[0]) {
    return found.paths[0];
  }

  throw new Error(
    `Protected command ${command} does not have a real target yet. Install the original tool first, or run "ais protect off ${command}".`,
  );
}

function createContext(options: ProtectRuntimeOptions): ProtectContext {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env.HOME ?? homedir();
  return {
    aisCliPath: options.aisCliPath ?? resolveManagedCliPath(),
    backupRootDir: join(homeDir, '.ais', 'backups'),
    env,
    homeDir,
    managedBinDir: join(homeDir, '.ais', 'bin'),
    nodePath: options.nodePath ?? process.execPath,
    now: options.now ?? Date.now,
    shellPath: options.shellPath ?? env.SHELL,
    shellRunner: options.shellRunner ?? runShellCommand,
  };
}

function resolveManagedCliPath(): string {
  const candidatePaths = [
    fileURLToPath(new URL('../../dist/cli.js', import.meta.url)),
    fileURLToPath(new URL('../cli.js', import.meta.url)),
    process.argv[1] ? resolve(process.argv[1]) : undefined,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  const foundPath = candidatePaths.find((candidatePath) => existsSync(candidatePath));
  if (foundPath) {
    return foundPath;
  }

  return resolve(join(process.cwd(), 'dist', 'cli.js'));
}

async function installToolTakeover(
  tool: ProtectTool,
  runtime: ProtectToolRuntimeState,
  context: ProtectContext,
): Promise<ToolOperationResult> {
  const commandInfo = await findCommandPaths(tool, context.env.PATH ?? process.env.PATH ?? '', {
    context,
    excludeDirs: [context.managedBinDir],
  });
  const collisionMessage = formatCollisionMessage(tool, commandInfo.collision);

  if (runtime.installed && runtime.managedPath && (await isManagedWrapper(runtime.managedPath))) {
    if (runtime.managedPath.startsWith(context.managedBinDir)) {
      const rewritten = await installPrependTakeover(tool, runtime, commandInfo, context);
      if (collisionMessage && !rewritten.warning) {
        rewritten.warning = collisionMessage;
      }
      return rewritten;
    }

    const rewritten = await installInPlaceTakeover(
      tool,
      runtime.managedPath,
      runtime.originalCommandPath ?? runtime.managedPath,
      runtime.backupPath,
      context,
    );
    if (collisionMessage && !rewritten.warning) {
      rewritten.warning = collisionMessage;
    }
    return rewritten;
  }

  if (commandInfo.firstPath && (await shouldUseInPlaceTakeover(commandInfo.firstPath, context.homeDir))) {
    const installed = await installInPlaceTakeover(tool, commandInfo.firstPath, commandInfo.firstPath, undefined, context);
    if (collisionMessage && !installed.warning) {
      installed.warning = collisionMessage;
    }
    return installed;
  }

  const prepended = await installPrependTakeover(tool, runtime, commandInfo, context);
  if (collisionMessage && !prepended.warning) {
    prepended.warning = collisionMessage;
  }
  return prepended;
}

async function installInPlaceTakeover(
  tool: ProtectTool,
  managedPath: string,
  originalCommandPath: string,
  currentBackupPath: string | undefined,
  context: ProtectContext,
): Promise<ToolOperationResult> {
  const backupPath = currentBackupPath ?? join(context.backupRootDir, tool, basename(originalCommandPath));
  const wrapper = createWrapperScript(tool, managedPath, context, backupPath);
  let warning: string | undefined;

  if (currentBackupPath && !existsSync(currentBackupPath)) {
    warning = `${tool}: backup target is missing, fallback lookup will be used until it is rebuilt.`;
  }

  if (await isManagedWrapper(managedPath)) {
    await writeExecutableFile(managedPath, wrapper);
    return {
      runtime: buildRuntimeState({
        backupPath,
        installed: true,
        lastError: warning,
        managedPath,
        originalCommandPath,
        suspended: false,
      }, context),
      usesManagedBin: false,
      warning,
    };
  }

  await mkdir(dirname(backupPath), { recursive: true });
  if (existsSync(backupPath)) {
    await rm(backupPath, { force: true, recursive: true });
  }

  let renamed = false;
  try {
    await rename(managedPath, backupPath);
    renamed = true;
    await writeExecutableFile(managedPath, wrapper);

    return {
      runtime: buildRuntimeState({
        backupPath,
        installed: true,
        lastError: warning,
        managedPath,
        originalCommandPath,
        suspended: false,
      }, context),
      usesManagedBin: false,
      warning,
    };
  } catch (error) {
    if (renamed) {
      await rm(managedPath, { force: true }).catch(() => undefined);
      await rename(backupPath, managedPath).catch(() => undefined);
    }

    return {
      error: `${tool}: failed to install in-place takeover (${toErrorMessage(error)})`,
      runtime: buildRuntimeState({
        installed: false,
        lastError: `install failed: ${toErrorMessage(error)}`,
        originalCommandPath,
        suspended: false,
      }, context),
      usesManagedBin: false,
    };
  }
}

async function installPrependTakeover(
  tool: ProtectTool,
  runtime: ProtectToolRuntimeState,
  commandInfo: ToolCommandInfo,
  context: ProtectContext,
): Promise<ToolOperationResult> {
  if (runtime.installed && runtime.managedPath && !runtime.managedPath.startsWith(context.managedBinDir)) {
    const removed = await removeToolTakeover(tool, runtime, context, false);
    if (removed.error) {
      return removed;
    }
  }

  const managedPath = join(context.managedBinDir, tool);
  await mkdir(context.managedBinDir, { recursive: true });
  await writeExecutableFile(managedPath, createWrapperScript(tool, managedPath, context));

  const warningParts: string[] = [];
  if (!commandInfo.firstPath) {
    warningParts.push(`${tool}: original command is not installed yet; AIS will wait for it to appear later.`);
  }
  const collisionMessage = formatCollisionMessage(tool, commandInfo.collision);
  if (collisionMessage) {
    warningParts.push(collisionMessage);
  }

  return {
    runtime: buildRuntimeState({
      installed: true,
      lastError: warningParts.length === 0 ? undefined : warningParts.join(' '),
      managedPath,
      originalCommandPath: commandInfo.firstPath,
      suspended: false,
    }, context),
    usesManagedBin: true,
    warning: warningParts.length === 0 ? undefined : warningParts.join(' '),
  };
}

async function removeToolTakeover(
  tool: ProtectTool,
  runtime: ProtectToolRuntimeState,
  context: ProtectContext,
  keepSuspended: boolean,
): Promise<ToolOperationResult> {
  const managedPath = runtime.managedPath;
  const backupPath = runtime.backupPath;
  const originalCommandPath = runtime.originalCommandPath;

  if (managedPath && managedPath.startsWith(context.managedBinDir)) {
    if (existsSync(managedPath)) {
      await rm(managedPath, { force: true }).catch(() => undefined);
    }

    const commandInfo = await findCommandPaths(tool, context.env.PATH ?? process.env.PATH ?? '', {
      context,
      excludeDirs: [context.managedBinDir],
    });

    return {
      runtime: buildRuntimeState({
        installed: false,
        lastError: undefined,
        originalCommandPath: commandInfo.firstPath ?? originalCommandPath,
        suspended: keepSuspended,
      }, context),
      usesManagedBin: false,
    };
  }

  if (managedPath && backupPath && existsSync(backupPath)) {
    const managedIsWrapper = await isManagedWrapper(managedPath);

    try {
      if (managedIsWrapper) {
        await rm(managedPath, { force: true });
        await rename(backupPath, originalCommandPath ?? managedPath);
      } else if (!existsSync(originalCommandPath ?? managedPath)) {
        await rename(backupPath, originalCommandPath ?? managedPath);
      } else {
        await rm(backupPath, { force: true, recursive: true });
      }

      return {
        runtime: buildRuntimeState({
          installed: false,
          lastError: undefined,
          originalCommandPath: originalCommandPath ?? managedPath,
          suspended: keepSuspended,
        }, context),
        usesManagedBin: false,
      };
    } catch (error) {
      return {
        error: `${tool}: failed to restore original command (${toErrorMessage(error)})`,
        runtime: buildRuntimeState({
          backupPath,
          installed: managedIsWrapper,
          lastError: `restore failed: ${toErrorMessage(error)}`,
          managedPath,
          originalCommandPath: originalCommandPath ?? managedPath,
          suspended: keepSuspended,
        }, context),
        usesManagedBin: false,
      };
    }
  }

  const commandInfo = await findCommandPaths(tool, context.env.PATH ?? process.env.PATH ?? '', {
    context,
    excludeDirs: [context.managedBinDir],
  });

  return {
    runtime: buildRuntimeState({
      installed: false,
      lastError: undefined,
      originalCommandPath: commandInfo.firstPath ?? originalCommandPath,
      suspended: keepSuspended,
    }, context),
    usesManagedBin: false,
  };
}

async function inspectToolRuntime(
  tool: ProtectTool,
  runtime: ProtectToolRuntimeState,
  context: ProtectContext,
): Promise<ToolOperationResult> {
  const nextRuntime = {
    ...runtime,
  };

  const commandInfo = await findCommandPaths(tool, context.env.PATH ?? process.env.PATH ?? '', {
    context,
    excludeDirs: [context.managedBinDir],
    excludePaths: runtime.managedPath ? [runtime.managedPath] : [],
  });

  if (!runtime.managedPath) {
    nextRuntime.installed = false;
    nextRuntime.originalCommandPath = commandInfo.firstPath;
    nextRuntime.lastError = undefined;
    return {
      runtime: nextRuntime,
      usesManagedBin: false,
    };
  }

  const installed = await isManagedWrapper(runtime.managedPath);
  const warningParts: string[] = [];
  const collisionMessage = formatCollisionMessage(tool, commandInfo.collision);
  if (collisionMessage) {
    warningParts.push(collisionMessage);
  }
  if (runtime.managedPath.startsWith(context.managedBinDir) && !commandInfo.firstPath) {
    warningParts.push(`${tool}: original command is not installed yet.`);
  }
  if (!installed) {
    warningParts.push(`${tool}: managed entry is missing or has been replaced.`);
  }

  nextRuntime.installed = installed;
  nextRuntime.originalCommandPath = commandInfo.firstPath ?? runtime.originalCommandPath;
  nextRuntime.lastError = warningParts.length === 0 ? undefined : warningParts.join(' ');
  return {
    runtime: nextRuntime,
    usesManagedBin: runtime.managedPath.startsWith(context.managedBinDir),
    warning: warningParts.length === 0 ? undefined : warningParts.join(' '),
  };
}

async function shouldUseInPlaceTakeover(commandPath: string, homeDir: string): Promise<boolean> {
  const normalized = resolve(commandPath);
  if (!normalized.startsWith(resolve(homeDir))) {
    return false;
  }

  const lower = normalized.toLowerCase();
  if (
    lower.includes('/.npm-global/bin/') ||
    lower.includes('/.npm/bin/') ||
    lower.includes('/node_modules/.bin/')
  ) {
    return true;
  }

  try {
    const entry = await lstat(commandPath);
    if (entry.isSymbolicLink()) {
      const linked = resolve(dirname(commandPath), await readlink(commandPath)).toLowerCase();
      return linked.includes('/node_modules/');
    }
  } catch {
    return false;
  }

  return false;
}

async function findCommandPaths(
  tool: ProtectTool,
  pathValue: string,
  options: {
    context?: ProtectContext;
    excludeDirs?: string[];
    excludePaths?: string[];
  } = {},
): Promise<ToolCommandInfo> {
  const directories = pathValue
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(entry));
  const excludeDirs = new Set((options.excludeDirs ?? []).map((entry) => resolve(entry)));
  const excludePaths = new Set((options.excludePaths ?? []).filter(Boolean).map((entry) => resolve(entry)));
  const paths: string[] = [];

  for (const directory of directories) {
    if (excludeDirs.has(directory)) {
      continue;
    }

    const candidate = resolve(directory, tool);
    if (excludePaths.has(candidate)) {
      continue;
    }

    if (!(await isExecutablePath(candidate))) {
      continue;
    }

    paths.push(candidate);
  }

  const shellInspection = await inspectShellCommand(tool, options.context);
  return {
    collision: shellInspection.collision,
    firstPath: paths[0],
    paths,
  };
}

async function inspectShellCommand(
  tool: ProtectTool,
  context?: ProtectContext,
): Promise<Pick<ToolCommandInfo, 'collision'>> {
  if (!context?.shellPath) {
    return {};
  }

  try {
    const result = await context.shellRunner(context.shellPath, ['-lic', `type -a ${tool}`], {
      env: context.env,
    });
    if (result.exitCode !== 0) {
      return {};
    }

    const firstLine = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (!firstLine) {
      return {};
    }

    if (/\b(alias|aliased)\b/i.test(firstLine)) {
      return { collision: 'alias' };
    }

    if (/\bfunction\b/i.test(firstLine)) {
      return { collision: 'function' };
    }
  } catch {
    return {};
  }

  return {};
}

async function ensureShellBlock(context: ProtectContext): Promise<boolean> {
  const targets = await resolveShellTargets(context);
  const block = buildShellBlock();
  let changed = false;

  for (const target of targets) {
    const current = existsSync(target) ? await readFile(target, 'utf8') : '';
    const next = stripShellBlock(current).replace(/\s+$/, '');
    const content = next.length === 0 ? `${block}\n` : `${next}\n\n${block}\n`;

    if (current === content) {
      continue;
    }

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
    changed = true;
  }

  return changed;
}

async function removeShellBlock(context: ProtectContext): Promise<boolean> {
  const targets = await resolveShellTargets(context, true);
  let changed = false;

  for (const target of targets) {
    if (!existsSync(target)) {
      continue;
    }

    const current = await readFile(target, 'utf8');
    const next = stripShellBlock(current).replace(/\s+$/, '');
    const content = next.length === 0 ? '' : `${next}\n`;
    if (current === content) {
      continue;
    }

    await writeFile(target, content, 'utf8');
    changed = true;
  }

  return changed;
}

async function resolveShellTargets(context: ProtectContext, includeAllExisting = false): Promise<string[]> {
  const candidates = [
    join(context.homeDir, '.zshrc'),
    join(context.homeDir, '.zprofile'),
    join(context.homeDir, '.bashrc'),
    join(context.homeDir, '.bash_profile'),
  ];
  const existing = candidates.filter((target) => existsSync(target));
  if (includeAllExisting) {
    return existing;
  }

  if (existing.length > 0) {
    return existing;
  }

  const shellPath = context.shellPath ?? '';
  if (shellPath.includes('bash')) {
    return [join(context.homeDir, '.bashrc')];
  }

  return [join(context.homeDir, '.zshrc')];
}

function buildShellBlock(): string {
  return [
    SHELL_BLOCK_START,
    'if [ -d "$HOME/.ais/bin" ]; then',
    '  export PATH="$HOME/.ais/bin:$PATH"',
    'fi',
    SHELL_BLOCK_END,
  ].join('\n');
}

function stripShellBlock(content: string): string {
  const pattern = new RegExp(`${escapeForRegExp(SHELL_BLOCK_START)}[\\s\\S]*?${escapeForRegExp(SHELL_BLOCK_END)}\\n?`, 'g');
  return content.replace(pattern, '');
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createWrapperScript(
  tool: ProtectTool,
  managedPath: string,
  context: ProtectContext,
  realCommandPath?: string,
): string {
  return [
    '#!/bin/sh',
    MANAGED_WRAPPER_MARKER,
    `export AIS_PROTECT_WRAPPER_ACTIVE=${quoteForShell('1')}`,
    `export AIS_PROTECT_TOOL=${quoteForShell(tool)}`,
    `export AIS_PROTECT_WRAPPER_PATH=${quoteForShell(managedPath)}`,
    `export AIS_PROTECT_WRAPPER_DIR=${quoteForShell(context.managedBinDir)}`,
    `export AIS_PROTECT_REAL_COMMAND=${quoteForShell(realCommandPath ?? '')}`,
    `exec ${quoteForShell(context.nodePath)} ${quoteForShell(context.aisCliPath)} ${quoteForShell(tool)} "$@"`,
    '',
  ].join('\n');
}

function buildRuntimeState(
  state: Partial<ProtectToolRuntimeState>,
  context: ProtectContext,
): ProtectToolRuntimeState {
  return {
    ...createDefaultProtectToolRuntimeState(),
    ...state,
    lastChangedAt: context.now(),
  };
}

function formatCollisionMessage(tool: ProtectTool, collision: ToolCommandInfo['collision']): string | undefined {
  if (!collision) {
    return undefined;
  }

  return `${tool}: your current shell still has a ${collision} ahead of AIS, so direct launches may keep hitting that ${collision}.`;
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function isManagedWrapper(filePath: string): Promise<boolean> {
  if (!existsSync(filePath)) {
    return false;
  }

  try {
    const content = await readFile(filePath, 'utf8');
    return content.includes(MANAGED_WRAPPER_MARKER);
  } catch {
    return false;
  }
}

async function isExecutablePath(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    if (stats.isDirectory()) {
      return false;
    }
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeExecutableFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, 'utf8');
  await chmod(path, EXECUTABLE_MODE);
}

async function runShellCommand(
  command: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
  },
): Promise<ProtectShellCommandResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolvePromise({
        exitCode: exitCode ?? 1,
        stderr,
        stdout,
      });
    });
  });
}

function hasStateChanged(previous: AutomationState, next: AutomationState): boolean {
  return JSON.stringify(previous) !== JSON.stringify(next);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
