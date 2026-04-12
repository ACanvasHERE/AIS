import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { AisStore, type AisState } from './ais/index.js';
import {
  PROTECT_TOOLS,
  loadAutomationState,
  saveAutomationState,
  type AutomationState,
  type LoadedAutomationState,
  type ProtectTool,
} from './automation/index.js';
import { AisRuntime, type AisStats, type AisRuntimeOptions } from './ais-runtime.js';
import { parseCliInvocation, type CliGlobalOptions } from './cli-options.js';
import {
  createDefaultConfig,
  expandHomePath,
  loadConfig,
  saveConfig,
  type AisConfig,
} from './config.js';
import { PatternDetector } from './detector/pattern-detector.js';
import { getPackageInfo, VERSION } from './package-info.js';
import {
  refreshProtectRuntime,
  resolveProtectedCommand,
  restoreProtectRuntime,
  syncProtectRuntime,
  type ProtectRuntimeOptions,
  type ProtectShellRunner,
} from './protect/index.js';
import { EncryptedVault, StorageManager } from './storage/index.js';
import {
  maybeRunStartupSelfUpdate,
  resolveCurrentPackageRootFromUrl,
  runManualSelfUpdate,
  type UpdateCommandRunner,
} from './update/self-update.js';
import type { SecretType, VaultEntry } from './vault/types.js';

const HELP_TEXT = `AIS - Local protection for AI agent secrets

Usage:
  ais <command> [args...]           Wrap an AI agent with secret protection
  ais add <name> [secret]           Register a secret in the vault
  ais ais [show]                    Open the AIS TUI for recent records
  ais protect <action>              Manage default protection preferences
  ais list                          List registered secrets
  ais remove <name>                 Remove a secret from the vault
  ais status                        Show current local status
  ais update                        Check now and install a newer version when available
  ais config                        View or create configuration

Options:
  -v, --version        Show version
  -h, --help           Show help
  -d, --debug          Enable debug output
  -c, --config <path>  Use a custom config file
  --proxy-port <port>  Use a fixed local proxy port
  --skip-update-check  Skip the automatic update check for this run
  --dry-run            Detect but do not replace
  --no-entropy         Disable entropy detection
  --no-context         Disable context keyword detection

Examples:
  ais claude
  ais -- codex --sandbox danger-full-access
  ais ais
  ais protect off codex
  ais config set update.channel next
  ais add github-token
  ais add github-token ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`;

type AisRuntimeLike = {
  getStats(): AisStats;
  start(command: string, args: string[]): Promise<void>;
};

export interface CliRunOptions {
  createAisRuntime?: (options: AisRuntimeOptions) => AisRuntimeLike;
  currentCliPath?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
  protectNodePath?: string;
  protectShellPath?: string;
  protectShellRunner?: ProtectShellRunner;
  readSecret?: (name: string) => Promise<string>;
  stderr?: Pick<Writable, 'write'>;
  stdin?: NodeJS.ReadStream;
  stdout?: Pick<Writable, 'write'>;
  updateCommandRunner?: UpdateCommandRunner;
  updateCurrentPackageRoot?: string;
}

export async function runCli(args: string[], options: CliRunOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const env = options.env ?? process.env;
  const invocation = parseCliInvocation(args);

  try {
    if (invocation.type === 'error') {
      writeLine(stderr, invocation.message);
      return 1;
    }

    if (invocation.type === 'help') {
      writeLine(stdout, HELP_TEXT);
      return 0;
    }

    if (invocation.type === 'version') {
      writeLine(stdout, VERSION);
      return 0;
    }

    const loadedConfig = await loadConfig(invocation.options.config);
    const config = loadedConfig.config;
    const loadedAutomationState = await loadAutomationState(config.automation.statePath);
    const packageInfo = getPackageInfo();
    const updateCurrentPackageRoot = resolveUpdateCurrentPackageRoot(options, packageInfo.name);
    const storageManager = new StorageManager({
      env,
      persistDetectedSecrets: config.storage.persistSecrets,
      vaultPath: expandHomePath(config.storage.vaultPath),
    });
    const protectRuntimeOptions = buildProtectRuntimeOptions(env, options);
    const aisStore = new AisStore({
      path: config.ais.statePath,
      recentLimit: config.ais.recentLimit,
    });
    await aisStore.load();
    writeAutomationStateRecoveryWarning(stderr, loadedAutomationState);

    switch (invocation.type) {
      case 'ais': {
        if (invocation.action === 'show') {
          if (shouldRunInteractiveAis(options.stdin ?? process.stdin, stdout)) {
            await runAisTui(aisStore, loadedConfig.path);
          } else {
            writeLine(stdout, formatAisDashboard(aisStore.getState(), loadedConfig.path, aisStore.getPath()));
          }
          return 0;
        }

        if (invocation.action === 'exclude' || invocation.action === 'include') {
          const excluded = invocation.action === 'exclude';
          const target = invocation.target ?? '';
          const found = aisStore.setRecordExcluded(target, excluded);
          if (!found) {
            throw new Error(`AIS recent record not found: ${target}`);
          }

          await aisStore.save();
          writeLine(
            stdout,
            excluded ? `AIS recent record ${target} will stay plain next time.` : `AIS recent record ${target} is protected again.`,
          );
          return 0;
        }

        const secretType = invocation.secretType;
        if (!secretType) {
          throw new Error('AIS type action requires a secret type.');
        }

        const excluded = invocation.action === 'exclude-type';
        aisStore.setTypeExcluded(secretType, excluded);
        await aisStore.save();
        writeLine(
          stdout,
          excluded ? `AIS type ${secretType} will stay plain next time.` : `AIS type ${secretType} is protected again.`,
        );
        return 0;
      }

      case 'config': {
        if (invocation.action === 'show') {
          if (!loadedConfig.exists) {
            await saveConfig(config, loadedConfig.path);
          }

          writeLine(stdout, `Config: ${loadedConfig.path}`);
          writeLine(stdout, JSON.stringify(config, null, 2));
          return 0;
        }

        if (invocation.action === 'get') {
          const value = readConfigValue(config, invocation.key);
          writeLine(stdout, formatConfigValue(invocation.key, value));
          return 0;
        }

        const nextConfig = setConfigValue(config, invocation.key, invocation.value);
        await saveConfig(nextConfig, loadedConfig.path);
        writeLine(stdout, `Config updated: ${formatConfigValue(invocation.key, readConfigValue(nextConfig, invocation.key))}`);
        return 0;
      }

      case 'protect': {
        if (invocation.action === 'status') {
          const refreshed = await refreshProtectRuntime(loadedAutomationState.state, protectRuntimeOptions);
          if (refreshed.changed) {
            await saveAutomationState(refreshed.state, loadedAutomationState.path);
          }

          writeLine(stdout, formatProtectStatus(config, { ...loadedAutomationState, state: refreshed.state }));
          return 0;
        }

        if (invocation.action === 'restore') {
          const restored = await restoreProtectRuntime(config, loadedAutomationState.state, protectRuntimeOptions);
          await saveConfig(restored.config, loadedConfig.path);
          await saveAutomationState(restored.state, loadedAutomationState.path);
          writeProtectMessages(stderr, restored);
          writeLine(stdout, 'Protect restored to the original command layout.');
          return restored.errors.length === 0 ? 0 : 1;
        }

        if (invocation.action !== 'on' && invocation.action !== 'off') {
          throw new Error(`Unsupported protect action: ${String(invocation.action)}`);
        }

        const nextConfig = applyProtectPreference(config, invocation.action, invocation.target);
        const syncedProtect = await syncProtectRuntime(nextConfig, loadedAutomationState.state, protectRuntimeOptions);
        await saveConfig(nextConfig, loadedConfig.path);
        await saveAutomationState(syncedProtect.state, loadedAutomationState.path);
        writeProtectMessages(stderr, syncedProtect);
        writeLine(stdout, `Protect updated: ${invocation.target}=${invocation.action === 'on' ? 'on' : 'off'}`);
        return syncedProtect.errors.length === 0 ? 0 : 1;
      }

      case 'add': {
        const created = await storageManager.setup();
        if (created) {
          writeWelcome(stdout, storageManager.getVaultPath());
        }

        const secret =
          invocation.secret ??
          (await (options.readSecret ?? defaultReadSecret)(invocation.name, options.stdin ?? process.stdin, stderr));
        if (secret.trim().length === 0) {
          throw new Error('Secret cannot be empty.');
        }

        if (invocation.secret) {
          writeLine(stderr, '注意：secret 已出现在命令历史中，请删除对应的 history 记录。');
        }

        const vault = await storageManager.initialize();
        const token = vault.register(
          secret,
          inferSecretType(invocation.name, secret, config),
          {
            name: invocation.name,
            source: 'manual',
          },
        );
        await storageManager.save(vault);
        aisStore.recordSecret(secret, inferSecretType(invocation.name, secret, config), {
          name: invocation.name,
          source: 'manual',
        });
        await aisStore.save();

        writeLine(stdout, `Secret "${invocation.name}" registered as ${token}`);
        writeLine(stdout, 'Saved to vault.');
        return 0;
      }

      case 'list': {
        const vault = await storageManager.initialize();
        const entries = vault.snapshot();
        writeLine(stdout, formatList(entries, options.now ?? Date.now));
        return 0;
      }

      case 'remove': {
        const vault = await storageManager.initialize();
        const removed = vault.removeByName(invocation.name);
        if (!removed) {
          throw new Error(`Secret "${invocation.name}" not found.`);
        }

        await storageManager.save(vault);
        writeLine(stdout, `Secret "${invocation.name}" removed from vault.`);
        return 0;
      }

      case 'status': {
        const vault = await storageManager.initialize();
        const refreshed = await refreshProtectRuntime(loadedAutomationState.state, protectRuntimeOptions);
        if (refreshed.changed) {
          await saveAutomationState(refreshed.state, loadedAutomationState.path);
        }
        writeLine(
          stdout,
          formatStatus(
            vault.snapshot(),
            loadedConfig.path,
            storageManager.getVaultPath(),
            aisStore.getPath(),
            {
              ...loadedAutomationState,
              state: refreshed.state,
            },
            config,
          ),
        );
        return 0;
      }

      case 'update': {
        const updateResult = await runManualSelfUpdate(
          loadedAutomationState.state,
          {
            channel: config.update.channel,
          },
          {
            automationStatePath: loadedAutomationState.path,
            commandRunner: options.updateCommandRunner,
            currentPackageRoot: updateCurrentPackageRoot,
            env,
            fetchImpl: options.fetch,
            now: options.now,
            packageInfo,
          },
        );

        if (updateResult.changed) {
          await saveAutomationState(updateResult.state, loadedAutomationState.path);
        }
        if (updateResult.message) {
          writeLine(updateResult.status === 'failed' ? stderr : stdout, updateResult.message);
        }

        return updateResult.status === 'failed' ? 1 : 0;
      }

      case 'wrap': {
        const created = await storageManager.setup();
        if (created) {
          writeWelcome(stdout, storageManager.getVaultPath());
        }

        const updateCheck = await maybeRunStartupSelfUpdate(
          loadedAutomationState.state,
          {
            ...config.update,
            skipCheck: invocation.options.skipUpdateCheck,
          },
          {
            automationStatePath: loadedAutomationState.path,
            commandRunner: options.updateCommandRunner,
            currentPackageRoot: updateCurrentPackageRoot,
            env,
            fetchImpl: options.fetch,
            now: options.now,
            packageInfo,
          },
        );
        const automationState = updateCheck.state;
        if (updateCheck.changed) {
          await saveAutomationState(automationState, loadedAutomationState.path);
        }
        if (updateCheck.message) {
          writeLine(stderr, updateCheck.message);
        }

        const aisRuntime = (options.createAisRuntime ?? ((nextOptions) => new AisRuntime(nextOptions)))({
          debug: invocation.options.debug || config.display.debug,
          detector: buildDetectorOptions(config, invocation.options),
          dryRun: invocation.options.dryRun,
          env,
          proxy:
            invocation.options.proxyPort === undefined
              ? undefined
              : {
                  maxPortAttempts: 1,
                  port: invocation.options.proxyPort,
                },
          storage: {
            env,
            persistDetectedSecrets: config.storage.persistSecrets,
            vaultPath: storageManager.getVaultPath(),
          },
          ais: {
            recentLimit: config.ais.recentLimit,
            path: aisStore.getPath(),
            store: aisStore,
          },
          automation: {
            path: loadedAutomationState.path,
            protect: config.protect,
            state: automationState,
            update: {
              ...config.update,
              skipCheck: invocation.options.skipUpdateCheck,
            },
          },
        });

        const resolvedCommand = await resolveProtectedCommand(invocation.command, env, {
          homeDir: env.HOME,
        });
        await aisRuntime.start(resolvedCommand, invocation.args);
        return 0;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeLine(stderr, message);
    return 1;
  }
}

function buildDetectorOptions(config: AisConfig, options: CliGlobalOptions): AisRuntimeOptions['detector'] {
  return {
    customPatterns: config.customPatterns,
    enableContext: options.noContext ? false : config.detection.context,
    enableEntropy: options.noEntropy ? false : config.detection.entropy,
    enablePattern: config.detection.patterns,
    entropyThreshold: config.detection.entropyThreshold,
  };
}

function resolveUpdateCurrentPackageRoot(options: CliRunOptions, packageName: string): string | undefined {
  if (options.updateCurrentPackageRoot) {
    return options.updateCurrentPackageRoot;
  }

  const candidatePath = options.currentCliPath ?? process.argv[1];
  if (!candidatePath) {
    return undefined;
  }

  try {
    return resolveCurrentPackageRootFromUrl(pathToFileURL(candidatePath).href, packageName);
  } catch {
    return undefined;
  }
}

function buildProtectRuntimeOptions(env: NodeJS.ProcessEnv, options: CliRunOptions): ProtectRuntimeOptions {
  return {
    aisCliPath: options.currentCliPath ?? process.argv[1],
    env,
    nodePath: options.protectNodePath,
    now: options.now,
    shellPath: options.protectShellPath,
    shellRunner: options.protectShellRunner,
  };
}

function writeProtectMessages(
  stderr: Pick<Writable, 'write'>,
  result: {
    errors: string[];
    warnings: string[];
  },
): void {
  for (const warning of result.warnings) {
    writeLine(stderr, warning);
  }

  for (const error of result.errors) {
    writeLine(stderr, error);
  }
}

function formatList(entries: VaultEntry[], now: () => number): string {
  if (entries.length === 0) {
    return 'No stored secrets.';
  }

  const namedEntries = entries.filter((entry) => entry.name);
  const unnamedCount = entries.length - namedEntries.length;

  if (namedEntries.length === 0) {
    return `No named secrets.\nUnnamed stored secrets: ${unnamedCount}`;
  }

  const rows = [
    ['Name', 'Type', 'Token', 'Added'],
    ...namedEntries
      .sort((left, right) => (left.name ?? '').localeCompare(right.name ?? ''))
      .map((entry) => [
        entry.name ?? '',
        entry.type,
        entry.token,
        formatRelativeAge(entry.createdAt, now()),
      ]),
  ];
  const widths = rows[0].map((_, columnIndex) =>
    Math.max(...rows.map((row) => row[columnIndex].length)),
  );
  const formattedRows = rows.map((row) =>
    row
      .map((cell, columnIndex) => cell.padEnd(widths[columnIndex]))
      .join('  ')
      .trimEnd(),
  );

  if (unnamedCount === 0) {
    return formattedRows.join('\n');
  }

  return `${formattedRows.join('\n')}\nUnnamed stored secrets: ${unnamedCount}`;
}

function formatRelativeAge(createdAt: number, now: number): string {
  const diff = Math.max(0, now - createdAt);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) {
    return 'just now';
  }

  if (diff < hour) {
    return `${Math.floor(diff / minute)}m ago`;
  }

  if (diff < day) {
    return `${Math.floor(diff / hour)}h ago`;
  }

  return `${Math.floor(diff / day)}d ago`;
}

function formatStatus(
  entries: VaultEntry[],
  configPath: string,
  vaultPath: string,
  aisStatePath: string,
  automationState: LoadedAutomationState,
  config: AisConfig,
): string {
  const namedCount = entries.filter((entry) => entry.name).length;

  return [
    'Session: inactive',
    `Vault: ${entries.length} secrets stored (${namedCount} named)`,
    `Config: ${configPath}`,
    `Vault file: ${vaultPath}`,
    `AIS state: ${aisStatePath}`,
    `Automation state: ${automationState.path}`,
    formatUpdateStatus(config, automationState.state),
    formatProtectSummary(config, automationState.state),
  ].join('\n');
}

function formatUpdateStatus(config: AisConfig, state: AutomationState): string {
  const checkedAt = state.update.lastCheckedAt ? new Date(state.update.lastCheckedAt).toISOString() : 'never';
  const remoteVersion = state.update.lastRemoteVersion ?? '-';
  const localVersion = state.update.lastLocalVersion ?? VERSION;

  return [
    `Update: ${config.update.enabled ? 'enabled' : 'disabled'} | channel=${config.update.channel} | every=${config.update.checkIntervalMinutes}m | silent=${config.update.silent ? 'yes' : 'no'} | last=${state.update.lastResult}`,
    `Update detail: checkedAt=${checkedAt} | local=${localVersion} | remote=${remoteVersion} | skipNext=${state.update.skipNextCheck ? 'yes' : 'no'}`,
  ].join('\n');
}

function formatProtectSummary(config: AisConfig, state: AutomationState): string {
  const toolLines = PROTECT_TOOLS.map((tool) => formatProtectToolLine(tool, config, state));
  return [
    `Protect: ${config.protect.enabled ? 'enabled' : 'disabled'}`,
    ...toolLines,
  ].join('\n');
}

function formatProtectStatus(config: AisConfig, automationState: LoadedAutomationState): string {
  return [
    `Automation state: ${automationState.path}`,
    formatProtectSummary(config, automationState.state),
  ].join('\n');
}

function formatProtectToolLine(tool: ProtectTool, config: AisConfig, state: AutomationState): string {
  const runtime = state.protect.tools[tool];
  const desired = config.protect.enabled && config.protect.tools[tool] ? 'on' : 'off';
  const applied = runtime.installed ? 'yes' : 'no';
  const suspended = runtime.suspended ? 'yes' : 'no';
  const restoreParts = [
    runtime.managedPath ? `managed=${runtime.managedPath}` : '',
    runtime.backupPath ? `backup=${runtime.backupPath}` : '',
    runtime.originalCommandPath ? `original=${runtime.originalCommandPath}` : '',
  ].filter(Boolean);
  const restore = restoreParts.length === 0 ? 'restore=empty' : `restore=${restoreParts.join(',')}`;
  const error = runtime.lastError ? ` | error=${runtime.lastError}` : '';

  return `Protect ${tool}: desired=${desired} | applied=${applied} | suspended=${suspended} | ${restore}${error}`;
}

function writeAutomationStateRecoveryWarning(
  stderr: Pick<Writable, 'write'>,
  loadedAutomationState: LoadedAutomationState,
): void {
  if (!loadedAutomationState.recoveryReason) {
    return;
  }

  const recoveredFrom = loadedAutomationState.recoveredFrom ?? loadedAutomationState.path;
  writeLine(
    stderr,
    `Automation state was reset after a load failure (${loadedAutomationState.recoveryReason}). Previous file: ${recoveredFrom}`,
  );
}

function readConfigValue(config: AisConfig, key: string): boolean | number | string {
  switch (key) {
    case 'automation.statePath':
      return config.automation.statePath;
    case 'protect.enabled':
      return config.protect.enabled;
    case 'protect.tools.claude':
      return config.protect.tools.claude;
    case 'protect.tools.codex':
      return config.protect.tools.codex;
    case 'protect.tools.openclaw':
      return config.protect.tools.openclaw;
    case 'update.channel':
      return config.update.channel;
    case 'update.checkIntervalMinutes':
      return config.update.checkIntervalMinutes;
    case 'update.enabled':
      return config.update.enabled;
    case 'update.silent':
      return config.update.silent;
    default:
      throw new Error(`Unsupported config key: ${key}`);
  }
}

function setConfigValue(config: AisConfig, key: string, rawValue: string): AisConfig {
  const nextConfig = structuredClone(config);

  switch (key) {
    case 'automation.statePath':
      nextConfig.automation.statePath = rawValue;
      return nextConfig;
    case 'protect.enabled':
      nextConfig.protect.enabled = parseBooleanValue(rawValue, key);
      return nextConfig;
    case 'protect.tools.claude':
      nextConfig.protect.tools.claude = parseBooleanValue(rawValue, key);
      return nextConfig;
    case 'protect.tools.codex':
      nextConfig.protect.tools.codex = parseBooleanValue(rawValue, key);
      return nextConfig;
    case 'protect.tools.openclaw':
      nextConfig.protect.tools.openclaw = parseBooleanValue(rawValue, key);
      return nextConfig;
    case 'update.channel':
      if (rawValue !== 'latest' && rawValue !== 'next') {
        throw new Error('update.channel must be "latest" or "next".');
      }

      nextConfig.update.channel = rawValue;
      return nextConfig;
    case 'update.checkIntervalMinutes':
      nextConfig.update.checkIntervalMinutes = parsePositiveIntegerValue(rawValue, key);
      return nextConfig;
    case 'update.enabled':
      nextConfig.update.enabled = parseBooleanValue(rawValue, key);
      return nextConfig;
    case 'update.silent':
      nextConfig.update.silent = parseBooleanValue(rawValue, key);
      return nextConfig;
    default:
      throw new Error(`Unsupported config key: ${key}`);
  }
}

function formatConfigValue(key: string, value: boolean | number | string): string {
  return `${key}=${value}`;
}

function parseBooleanValue(rawValue: string, key: string): boolean {
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }

  if (normalized === 'false') {
    return false;
  }

  throw new Error(`${key} must be "true" or "false".`);
}

function parsePositiveIntegerValue(rawValue: string, key: string): number {
  if (!/^\d+$/.test(rawValue)) {
    throw new Error(`${key} must be a positive integer.`);
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (parsed < 1) {
    throw new Error(`${key} must be a positive integer.`);
  }

  return parsed;
}

function applyProtectPreference(
  config: AisConfig,
  action: 'off' | 'on',
  target: ProtectTool | 'all',
): AisConfig {
  const nextConfig = structuredClone(config);

  if (target === 'all') {
    nextConfig.protect.enabled = action === 'on';
    if (action === 'on') {
      nextConfig.protect.tools.claude = true;
      nextConfig.protect.tools.codex = true;
      nextConfig.protect.tools.openclaw = true;
    }

    return nextConfig;
  }

  if (action === 'on') {
    nextConfig.protect.enabled = true;
  }

  nextConfig.protect.tools[target] = action === 'on';
  return nextConfig;
}

function inferSecretType(name: string, secret: string, config: AisConfig): SecretType {
  const exactMatch = new PatternDetector({
    customPatterns: config.customPatterns,
  })
    .detect(secret)
    .find((match) => match.start === 0 && match.end === secret.length);

  if (exactMatch) {
    return exactMatch.type;
  }

  const normalized = name.toLowerCase();
  if (normalized.includes('password') || normalized.includes('passwd') || normalized.includes('pass')) {
    return 'PASSWORD';
  }

  if (normalized.includes('private') || normalized.includes('pem') || normalized.includes('ssh')) {
    return 'PRIVATE_KEY';
  }

  if (normalized.includes('jwt')) {
    return 'JWT';
  }

  if (normalized.includes('bearer')) {
    return 'BEARER_TOKEN';
  }

  if (normalized.includes('token') || normalized.includes('key') || normalized.includes('secret')) {
    return 'APIKEY';
  }

  return 'GENERIC';
}

async function defaultReadSecret(
  name: string,
  stdin: NodeJS.ReadStream,
  output: Pick<Writable, 'write'>,
): Promise<string> {
  if (!stdin.isTTY) {
    return readSecretFromPipe(stdin);
  }

  return readSecretFromTerminal(name, stdin, output);
}

async function readSecretFromPipe(stdin: NodeJS.ReadStream): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function readSecretFromTerminal(
  name: string,
  stdin: NodeJS.ReadStream,
  output: Pick<Writable, 'write'>,
): Promise<string> {
  writeRaw(output, `Enter secret for "${name}": `);
  const originalRawMode = stdin.isRaw;
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise<string>((resolve, reject) => {
    let secret = '';

    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode?.(originalRawMode ?? false);
      writeRaw(output, '\n');
    };

    const onData = (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');

      for (const char of text) {
        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(secret);
          return;
        }

        if (char === '\u0003') {
          cleanup();
          reject(new Error('Secret input cancelled.'));
          return;
        }

        if (char === '\u007f' || char === '\b') {
          secret = secret.slice(0, -1);
          continue;
        }

        secret += char;
      }
    };

    stdin.on('data', onData);
  });
}

function writeLine(stream: Pick<Writable, 'write'>, message: string): void {
  writeRaw(stream, `${message}\n`);
}

function writeRaw(stream: Pick<Writable, 'write'>, message: string): void {
  stream.write(message);
}

function writeWelcome(output: Pick<Writable, 'write'>, vaultPath: string): void {
  writeLine(output, 'Welcome to AIS!');
  writeLine(output, 'Setting up secure vault...');
  writeLine(output, `Vault created at ${vaultPath}`);
  writeLine(output, 'You are ready. Run: ais claude');
}

function formatAisDashboard(state: AisState, configPath: string, aisStatePath: string): string {
  const recentLines =
    state.recentRecords.length === 0
      ? ['- No recent protected records yet.']
      : state.recentRecords.map((record, index) => {
          const status = state.excludedRecordIds.includes(record.id) ? 'excluded' : 'protected';
          const name = record.name ? ` | name=${record.name}` : '';
          return `${index + 1}. ${record.preview} | ${record.type} | id=${record.id} | ${status}${name}`;
        });
  const excludedTypes =
    state.excludedTypes.length === 0 ? ['- None'] : state.excludedTypes.map((type) => `- ${type}`);

  return [
    'AIS TUI',
    `Config: ${configPath}`,
    `AIS state: ${aisStatePath}`,
    '',
    'Recent protected records:',
    ...recentLines,
    '',
    'Excluded types:',
    ...excludedTypes,
    '',
    'Direct commands:',
    '  ais ais',
    '  ais ais exclude <id>',
    '  ais ais include <id>',
    '  ais ais exclude-type <type>',
    '  ais ais include-type <type>',
  ].join('\n');
}

async function runAisTui(store: AisStore, configPath: string): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      writeLine(process.stdout, formatAisDashboard(store.getState(), configPath, store.getPath()));
      const answer = (await rl.question(
        'AIS> 输入编号切换某条，输入 type:PASSWORD 切换某一类，直接回车退出: ',
      )).trim();
      if (answer.length === 0 || answer.toLowerCase() === 'q') {
        break;
      }

      if (/^\d+$/.test(answer)) {
        const index = Number.parseInt(answer, 10) - 1;
        const state = store.getState();
        const record = state.recentRecords[index];
        if (!record) {
          writeLine(process.stdout, `AIS: recent index ${answer} not found.`);
          continue;
        }

        const excluded = !state.excludedRecordIds.includes(record.id);
        store.setRecordExcluded(record.id, excluded);
        await store.save();
        writeLine(
          process.stdout,
          excluded ? `AIS: ${record.id} will stay plain next time.` : `AIS: ${record.id} is protected again.`,
        );
        continue;
      }

      const typeMatch = answer.match(/^type:(.+)$/i);
      if (typeMatch) {
        const normalizedType = typeMatch[1].trim().toUpperCase();
        if (!isKnownAisType(normalizedType)) {
          writeLine(process.stdout, `AIS: unknown type ${typeMatch[1].trim()}.`);
          continue;
        }

        const state = store.getState();
        const excluded = !state.excludedTypes.includes(normalizedType);
        store.setTypeExcluded(normalizedType, excluded);
        await store.save();
        writeLine(
          process.stdout,
          excluded
            ? `AIS: type ${normalizedType} will stay plain next time.`
            : `AIS: type ${normalizedType} is protected again.`,
        );
        continue;
      }

      writeLine(process.stdout, 'AIS: unsupported action.');
    }
  } finally {
    rl.close();
  }
}

function shouldRunInteractiveAis(
  stdin: NodeJS.ReadStream,
  stdout: Pick<Writable, 'write'>,
): stdout is NodeJS.WriteStream & Pick<Writable, 'write'> {
  return stdin === process.stdin && stdout === process.stdout && stdin.isTTY && process.stdout.isTTY;
}

function isKnownAisType(value: string): value is SecretType {
  return ['PASSWORD', 'APIKEY', 'DBCONN', 'PRIVATE_KEY', 'BEARER_TOKEN', 'JWT', 'GENERIC'].includes(value);
}

export function getHelpText(): string {
  return HELP_TEXT;
}

export async function ensureDefaultConfig(path?: string): Promise<AisConfig> {
  const config = createDefaultConfig();
  await saveConfig(config, path);
  return config;
}

export function hasVault(path: string): boolean {
  return EncryptedVault.exists(path);
}
