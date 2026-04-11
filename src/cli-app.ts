import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

import { AisStore, type AisState } from './ais/index.js';
import { AisAgent, type AisOptions, type AisStats } from './ais-agent.js';
import { parseCliInvocation, type CliGlobalOptions } from './cli-options.js';
import {
  createDefaultConfig,
  expandHomePath,
  loadConfig,
  saveConfig,
  type AisConfig,
} from './config.js';
import { PatternDetector } from './detector/pattern-detector.js';
import { VERSION } from './index.js';
import { EncryptedVault, StorageManager } from './storage/index.js';
import type { SecretType, VaultEntry } from './vault/types.js';

const HELP_TEXT = `AIS - Local protection for AI agent secrets

Usage:
  ais <command> [args...]           Wrap an AI agent with secret protection
  ais add <name> [secret]           Register a secret in the vault
  ais ais [show]                    Open the AIS TUI for recent records
  ais list                          List registered secrets
  ais remove <name>                 Remove a secret from the vault
  ais status                        Show current local status
  ais config                        View or create configuration

Options:
  -v, --version        Show version
  -h, --help           Show help
  -d, --debug          Enable debug output
  -c, --config <path>  Use a custom config file
  --proxy-port <port>  Use a fixed local proxy port
  --dry-run            Detect but do not replace
  --no-entropy         Disable entropy detection
  --no-context         Disable context keyword detection

Examples:
  ais claude
  ais -- codex --sandbox danger-full-access
  ais ais
  ais add github-token
  ais add github-token ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`;

type AisAgentLike = {
  getStats(): AisStats;
  start(command: string, args: string[]): Promise<void>;
};

export interface CliRunOptions {
  createAisAgent?: (options: AisOptions) => AisAgentLike;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  readSecret?: (name: string) => Promise<string>;
  stderr?: Pick<Writable, 'write'>;
  stdin?: NodeJS.ReadStream;
  stdout?: Pick<Writable, 'write'>;
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
    const storageManager = new StorageManager({
      env,
      persistDetectedSecrets: config.storage.persistSecrets,
      vaultPath: expandHomePath(config.storage.vaultPath),
    });
    const aisStore = new AisStore({
      path: config.ais.statePath,
      recentLimit: config.ais.recentLimit,
    });
    await aisStore.load();

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
        if (!loadedConfig.exists) {
          await saveConfig(config, loadedConfig.path);
        }

        writeLine(stdout, `Config: ${loadedConfig.path}`);
        writeLine(stdout, JSON.stringify(config, null, 2));
        return 0;
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
          writeLine(
            stderr,
            'Warning: the secret was passed on the command line and may be stored in shell history. Remove the history entry after this command.',
          );
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
        writeLine(stdout, formatStatus(vault.snapshot(), loadedConfig.path, storageManager.getVaultPath(), aisStore.getPath()));
        return 0;
      }

      case 'wrap': {
        const created = await storageManager.setup();
        if (created) {
          writeWelcome(stdout, storageManager.getVaultPath());
        }

        const agent = (options.createAisAgent ?? ((nextOptions) => new AisAgent(nextOptions)))({
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
        });

        await agent.start(invocation.command, invocation.args);
        return 0;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeLine(stderr, message);
    return 1;
  }
}

function buildDetectorOptions(config: AisConfig, options: CliGlobalOptions): AisOptions['detector'] {
  return {
    customPatterns: config.customPatterns,
    enableContext: options.noContext ? false : config.detection.context,
    enableEntropy: options.noEntropy ? false : config.detection.entropy,
    enablePattern: config.detection.patterns,
    entropyThreshold: config.detection.entropyThreshold,
  };
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

function formatStatus(entries: VaultEntry[], configPath: string, vaultPath: string, aisStatePath: string): string {
  const namedCount = entries.filter((entry) => entry.name).length;

  return [
    'Session: inactive',
    `Vault: ${entries.length} secrets stored (${namedCount} named)`,
    `Config: ${configPath}`,
    `Vault file: ${vaultPath}`,
    `AIS state: ${aisStatePath}`,
  ].join('\n');
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
        'AIS> Enter a number to toggle one item, or type type:PASSWORD to toggle a full type. Press Enter to exit: ',
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
