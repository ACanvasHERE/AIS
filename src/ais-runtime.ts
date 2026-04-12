import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { AisStore, type AisStoreOptions } from './ais/index.js';
import type { AutomationState, ProtectTool, UpdateChannel } from './automation/index.js';
import { CombinedDetector, type CombinedDetectorOptions } from './detector/index.js';
import { BidirectionalInterceptor } from './interceptor/bidirectional.js';
import { createPtyWrapper, type PtyWrapperOptions } from './pty/wrapper.js';
import {
  buildProxyEnvironment,
  getDefaultProxyTargets,
  ProxyServer,
  type ProxyOptions,
} from './proxy/index.js';
import { StorageManager, type StorageManagerOptions } from './storage/index.js';
import { SessionVault, type SessionVaultOptions } from './vault/session-vault.js';
import type { SecretType } from './vault/types.js';

const DEFAULT_DETECTION_WINDOW = 4096;
const VAULT_TOKEN_PATTERN = /__VAULT_[A-Z_]+_[0-9a-f]{8,9}__/g;

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ReplacementRule {
  source: string;
  target: string;
}

interface PlainAnsiView {
  consumedRawLength: number;
  ends: number[];
  plain: string;
  starts: number[];
}

interface ReplacementMatch {
  end: number;
  replacement: string;
  start: number;
}

interface RestoreResult {
  output: string;
  replacements: number;
}

interface RegisteredSecretResult {
  created: boolean;
  token: string;
}

export interface RegisterSecretValueOptions {
  name?: string;
}

export interface AisStats {
  detectedSecrets: number;
  maskedInputs: number;
  proxyEnabled: boolean;
  proxyPort: number | null;
  registeredSecrets: number;
  restoredOutputs: number;
}

export interface AisRuntimeOptions {
  ais?: (AisStoreOptions & { store?: AisStore }) | false;
  automation?: {
    path: string;
    protect: {
      enabled: boolean;
      tools: Record<ProtectTool, boolean>;
    };
    state: AutomationState;
    update: {
      channel: UpdateChannel;
      checkIntervalMinutes: number;
      enabled: boolean;
      silent: boolean;
      skipCheck: boolean;
    };
  };
  cwd?: string;
  debug?: boolean;
  detectionWindow?: number;
  detector?: CombinedDetectorOptions;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  logFile?: string;
  proxy?: Omit<ProxyOptions, 'vault'>;
  storage?: (StorageManagerOptions & { manager?: StorageManager }) | false;
  stdin?: PtyWrapperOptions['stdin'];
  stdout?: PtyWrapperOptions['stdout'];
  vault?: SessionVaultOptions;
}

function sortReplacementRules(rules: ReplacementRule[]): ReplacementRule[] {
  return rules.sort((left, right) => {
    if (right.source.length !== left.source.length) {
      return right.source.length - left.source.length;
    }

    return left.source.localeCompare(right.source);
  });
}

function buildPrefixes(sources: string[]): Set<string> {
  return new Set(
    sources.flatMap((source) =>
      Array.from({ length: Math.max(0, source.length - 1) }, (_, index) => source.slice(0, index + 1)),
    ),
  );
}

function redactSecret(secret: string): string {
  if (secret.length <= 3) {
    return `${secret.slice(0, 1)}***`;
  }

  return `${secret.slice(0, 6)}***`;
}

function parseAnsiView(input: string): PlainAnsiView {
  let cursor = 0;
  let plain = '';
  const starts: number[] = [];
  const ends: number[] = [];

  while (cursor < input.length) {
    if (input[cursor] !== '\x1b') {
      starts.push(cursor);
      plain += input[cursor];
      cursor += 1;
      ends.push(cursor);
      continue;
    }

    const ansiLength = readAnsiEscapeLength(input, cursor);
    if (ansiLength === 0) {
      break;
    }

    cursor += ansiLength;
  }

  return {
    plain,
    starts,
    ends,
    consumedRawLength: cursor,
  };
}

function readAnsiEscapeLength(input: string, start: number): number {
  if (input[start] !== '\x1b' || input[start + 1] !== '[') {
    return 0;
  }

  for (let cursor = start + 2; cursor < input.length; cursor += 1) {
    const code = input.charCodeAt(cursor);
    if (code >= 0x40 && code <= 0x7e) {
      return cursor - start + 1;
    }
  }

  return 0;
}

function findReplacementMatches(input: string, rules: ReplacementRule[]): ReplacementMatch[] {
  const matches: ReplacementMatch[] = [];
  let cursor = 0;

  while (cursor < input.length) {
    const matchedRule = rules.find((rule) => input.startsWith(rule.source, cursor));
    if (!matchedRule) {
      cursor += 1;
      continue;
    }

    matches.push({
      start: cursor,
      end: cursor + matchedRule.source.length,
      replacement: matchedRule.target,
    });
    cursor += matchedRule.source.length;
  }

  return matches;
}

function replaceKnownValues(input: string, rules: ReplacementRule[]): RestoreResult {
  if (rules.length === 0 || input.length === 0) {
    return { output: input, replacements: 0 };
  }

  let output = input;
  let replacements = 0;

  for (const rule of rules) {
    let nextOutput = '';
    let lastIndex = 0;
    let matched = false;
    let matchIndex = output.indexOf(rule.source);

    while (matchIndex !== -1) {
      matched = true;
      replacements += 1;
      nextOutput += output.slice(lastIndex, matchIndex);
      nextOutput += rule.target;
      lastIndex = matchIndex + rule.source.length;
      matchIndex = output.indexOf(rule.source, lastIndex);
    }

    if (matched) {
      nextOutput += output.slice(lastIndex);
      output = nextOutput;
    }
  }

  return { output, replacements };
}

export function stripVaultArtifacts(input: string): string {
  const sanitized = input.replace(VAULT_TOKEN_PATTERN, '');
  const trailingVaultPrefix = sanitized.lastIndexOf('__VAULT_');
  if (trailingVaultPrefix === -1) {
    return sanitized;
  }

  return sanitized.slice(0, trailingVaultPrefix);
}

function normalizeProxyDetectionInput(input: string): string {
  return input
    .replaceAll('\\r', '\r')
    .replaceAll('\\n', '\n')
    .replaceAll('\\"', '"')
    .replaceAll('\\\\', '\\');
}

class StdoutRestorer {
  private buffer = '';
  private prefixes = new Set<string>();
  private rules: ReplacementRule[] = [];
  private syncedRevision = -1;

  constructor(private readonly vault: SessionVault) {}

  push(chunk: string): RestoreResult {
    this.syncRules();

    const input = this.buffer + chunk;
    const view = parseAnsiView(input);
    const processableRaw = input.slice(0, view.consumedRawLength);
    const trailingRaw = input.slice(view.consumedRawLength);

    if (this.rules.length === 0) {
      this.buffer = trailingRaw;
      return {
        output: processableRaw,
        replacements: 0,
      };
    }

    if (view.plain.length === 0) {
      this.buffer = trailingRaw;
      return {
        output: processableRaw,
        replacements: 0,
      };
    }

    const tentativeLimit = view.plain.length - this.getLookbehindLength(view.plain);
    if (tentativeLimit <= 0) {
      this.buffer = input;
      return { output: '', replacements: 0 };
    }

    const matches = findReplacementMatches(view.plain, this.rules);
    const safeVisibleLimit = this.getSafeVisibleLimit(matches, tentativeLimit);
    const rawLimit =
      safeVisibleLimit >= view.plain.length
        ? view.consumedRawLength
        : safeVisibleLimit === 0
          ? 0
          : view.ends[safeVisibleLimit - 1];

    const replaced = this.replaceRaw(processableRaw, view, matches, safeVisibleLimit, rawLimit);
    this.buffer = input.slice(rawLimit);
    return replaced;
  }

  flush(): RestoreResult {
    this.syncRules();

    if (this.buffer.length === 0) {
      return { output: '', replacements: 0 };
    }

    if (this.rules.length === 0) {
      const remaining = this.buffer;
      this.buffer = '';
      return { output: remaining, replacements: 0 };
    }

    const input = this.buffer;
    this.buffer = '';
    const view = parseAnsiView(input);
    const replaced = this.replaceRaw(
      input.slice(0, view.consumedRawLength),
      view,
      findReplacementMatches(view.plain, this.rules),
      view.plain.length,
      view.consumedRawLength,
    );

    return {
      output: replaced.output + input.slice(view.consumedRawLength),
      replacements: replaced.replacements,
    };
  }

  private getLookbehindLength(input: string): number {
    const longestCandidate = Math.min(
      input.length,
      Math.max(0, ...this.rules.map((rule) => rule.source.length - 1)),
    );

    for (let length = longestCandidate; length > 0; length -= 1) {
      if (this.prefixes.has(input.slice(-length))) {
        return length;
      }
    }

    return 0;
  }

  private getSafeVisibleLimit(matches: ReplacementMatch[], tentativeLimit: number): number {
    let safeLimit = tentativeLimit;
    let changed = true;

    while (changed) {
      changed = false;

      for (const match of matches) {
        if (match.start >= safeLimit) {
          continue;
        }

        if (match.end > safeLimit) {
          safeLimit = match.start;
          changed = true;
        }
      }
    }

    return safeLimit;
  }

  private replaceRaw(
    raw: string,
    view: PlainAnsiView,
    matches: ReplacementMatch[],
    visibleLimit: number,
    rawLimit: number,
  ): RestoreResult {
    if (raw.length === 0) {
      return { output: '', replacements: 0 };
    }

    if (visibleLimit === 0) {
      return {
        output: raw.slice(0, rawLimit),
        replacements: 0,
      };
    }

    let cursor = 0;
    let output = '';
    let replacements = 0;

    for (const match of matches) {
      if (match.end > visibleLimit) {
        break;
      }

      const rawStart = view.starts[match.start];
      const rawEnd = view.ends[match.end - 1];

      if (rawStart < cursor || rawEnd > rawLimit) {
        continue;
      }

      output += raw.slice(cursor, rawStart);
      output += match.replacement;
      cursor = rawEnd;
      replacements += 1;
    }

    output += raw.slice(cursor, rawLimit);
    return { output, replacements };
  }

  private syncRules(): void {
    if (this.syncedRevision === this.vault.revision) {
      return;
    }

    this.rules = sortReplacementRules(
      this.vault
        .getTokenToSecretPairs()
        .map(([source, target]) => ({
          source,
          target,
        })),
    );
    this.prefixes = buildPrefixes(this.rules.map((rule) => rule.source));
    this.syncedRevision = this.vault.revision;
  }
}

export class AisRuntime {
  private readonly argvDetector: CombinedDetector;
  private readonly detector: CombinedDetector;
  private readonly detectionBuffers = {
    proxy: '',
    stdin: '',
  };
  private readonly aisStore?: AisStore;
  private readonly interceptor: BidirectionalInterceptor;
  private proxyPort: number | null = null;
  private readonly proxy: ProxyServer;
  private readonly storageManager?: StorageManager;
  private storageLoaded = false;
  private readonly stdoutRestorer: StdoutRestorer;
  private readonly vault: SessionVault;
  private readonly stats = {
    detectedSecrets: 0,
    maskedInputs: 0,
    restoredOutputs: 0,
  };
  private running = false;

  constructor(private readonly options: AisRuntimeOptions = {}) {
    this.vault = new SessionVault(options.vault);
    this.detector = new CombinedDetector(options.detector);
    this.argvDetector = new CombinedDetector({
      ...(options.detector ?? {}),
      enableEntropy: false,
    });
    this.interceptor = new BidirectionalInterceptor(this.vault);
    this.stdoutRestorer = new StdoutRestorer(this.vault);
    const mergedEnv = {
      ...process.env,
      ...(options.env ?? {}),
    };

    this.proxy = new ProxyServer({
      ...(options.proxy ?? {}),
      onRequestText: (data) => {
        options.proxy?.onRequestText?.(data);
        this.handleProxyRequestText(data);
      },
      targets: {
        ...getDefaultProxyTargets(mergedEnv),
        ...(options.proxy?.targets ?? {}),
      },
      vault: this.vault,
    });
    this.storageManager =
      options.storage && 'manager' in options.storage && options.storage.manager
        ? options.storage.manager
        : options.storage
          ? new StorageManager(options.storage)
          : undefined;
    this.aisStore =
      options.ais && 'store' in options.ais && options.ais.store
        ? options.ais.store
        : options.ais
          ? new AisStore(options.ais)
          : undefined;
  }

  async start(command: string, args: string[]): Promise<void> {
    if (this.running) {
      throw new Error('AIS is already running');
    }

    this.running = true;
    this.resetDetectionBuffers();
    let aisSaveError: unknown;
    let startError: unknown;
    let storageSaveError: unknown;

    const runtimeEnv = {
      ...process.env,
      ...(this.options.env ?? {}),
    };

    try {
      await this.loadAisState();
      await this.loadStoredSecrets();
      const preparedArgs = this.prepareArgs(args);
      let commandEnv = runtimeEnv;

      if (this.options.dryRun) {
        this.debug('dry-run enabled, proxy disabled');
      } else {
        try {
          this.proxyPort = await this.proxy.start();
          commandEnv = buildProxyEnvironment(this.proxy.getBaseUrl(), runtimeEnv);
          this.debug(`proxy started on :${this.proxyPort}`);
        } catch (error) {
          this.proxyPort = null;
          this.warn(`proxy failed to start, HTTP API requests are NOT protected (${toErrorMessage(error)})`);
          this.debug(`proxy failed (${toErrorMessage(error)}), fallback to PTY-only mode`);
        }
      }

      await createPtyWrapper(command, preparedArgs, {
        cwd: this.options.cwd,
        env: commandEnv,
        stdin: this.options.stdin,
        stdout: this.options.stdout,
        onStdinData: (data) => this.handleStdin(data),
        flushStdinData: () => this.flushStdin(),
        onStdoutData: (data) => this.handleStdout(data),
        flushStdoutData: () => this.flushStdout(),
      });
    } catch (error) {
      startError = error;
    } finally {
      this.running = false;
      this.resetDetectionBuffers();
      this.proxyPort = null;
      await this.proxy.stop().catch(() => undefined);

      if (this.storageManager) {
        try {
          await this.storageManager.save(this.vault);
        } catch (error) {
          storageSaveError = error;
          if (startError) {
            this.debug(`storage save failed (${toErrorMessage(error)})`);
          }
        }
      }

      if (this.aisStore) {
        try {
          await this.aisStore.save();
        } catch (error) {
          aisSaveError = error;
          if (startError || storageSaveError) {
            this.debug(`ais save failed (${toErrorMessage(error)})`);
          }
        }
      }
    }

    if (startError) {
      throw startError;
    }

    if (storageSaveError) {
      throw storageSaveError;
    }

    if (aisSaveError) {
      throw aisSaveError;
    }
  }

  registerSecret(
    secret: string,
    type: SecretType = 'GENERIC',
    options: RegisterSecretValueOptions = {},
  ): string {
    return this.registerSecretValue(secret, type, 'manual', options).token;
  }

  getStats(): AisStats {
    return {
      detectedSecrets: this.stats.detectedSecrets,
      maskedInputs: this.stats.maskedInputs,
      proxyEnabled: this.proxyPort !== null,
      proxyPort: this.proxyPort,
      registeredSecrets: this.vault.size,
      restoredOutputs: this.stats.restoredOutputs,
    };
  }

  private debug(message: string): void {
    if (!this.options.debug) {
      return;
    }

    this.writeMessage(message);
  }

  private warn(message: string): void {
    this.writeMessage(`WARNING: ${message}`);
  }

  private writeMessage(message: string): void {
    const line = `[AIS] ${message}`;
    process.stderr.write(`${line}\n`);

    if (!this.options.logFile) {
      return;
    }

    mkdirSync(dirname(this.options.logFile), { recursive: true });
    appendFileSync(this.options.logFile, `${line}\n`, 'utf8');
  }

  private async loadStoredSecrets(): Promise<void> {
    if (this.storageLoaded || !this.storageManager) {
      return;
    }

    const storedVault = await this.storageManager.initialize();
    for (const entry of storedVault.snapshot()) {
      if (this.aisStore?.isExcluded(entry.secret, entry.type)) {
        this.debug(`storage: skipped excluded secret ${redactSecret(entry.secret)}`);
        continue;
      }

      this.vault.register(entry.secret, entry.type, {
        createdAt: entry.createdAt,
        hitCount: entry.hitCount,
        name: entry.name,
        source: entry.source,
        token: entry.token,
      });
    }

    this.storageLoaded = true;
  }

  private async loadAisState(): Promise<void> {
    if (!this.aisStore) {
      return;
    }

    await this.aisStore.load();
  }

  private detectSecrets(input: string, source: 'argv' | 'stdin' | 'proxy'): void {
    if (input.length === 0) {
      return;
    }

    const normalizedInput = source === 'proxy' ? normalizeProxyDetectionInput(input) : input;
    const scanTarget =
      source === 'argv'
        ? stripVaultArtifacts(normalizedInput)
        : source === 'proxy'
          ? stripVaultArtifacts(normalizedInput)
          : (() => {
            const bufferSize = this.options.detectionWindow ?? DEFAULT_DETECTION_WINDOW;
            const nextBuffer = stripVaultArtifacts(`${this.detectionBuffers[source]}${normalizedInput}`);
            this.detectionBuffers[source] = nextBuffer.slice(-bufferSize);
            return this.detectionBuffers[source];
          })();

    if (scanTarget.length === 0) {
      return;
    }

    const detector = source === 'argv' ? this.argvDetector : this.detector;

    for (const detected of detector.detect(scanTarget)) {
      if (detected.value.startsWith('__VAULT_')) {
        continue;
      }

      const result = this.registerSecretValue(detected.value, detected.type, source);
      if (result.created) {
        this.stats.detectedSecrets += 1;
      }
    }
  }

  private flushStdin(): string {
    if (this.options.dryRun) {
      return '';
    }

    return this.interceptor.flush().input;
  }

  private flushStdout(): string {
    if (this.options.dryRun) {
      return '';
    }

    const restored = this.stdoutRestorer.flush();
    this.stats.restoredOutputs += restored.replacements;
    return restored.output;
  }

  private handleStdin(data: string): string {
    this.detectSecrets(data, 'stdin');

    if (this.options.dryRun) {
      return data;
    }

    const masked = this.interceptor.processInput(data);
    if (masked !== data) {
      this.stats.maskedInputs += 1;
    }

    return masked;
  }

  private handleStdout(data: string): string {
    if (this.options.dryRun) {
      return data;
    }

    const restored = this.stdoutRestorer.push(data);
    this.stats.restoredOutputs += restored.replacements;
    return restored.output;
  }

  private handleProxyRequestText(data: string): void {
    this.detectSecrets(data, 'proxy');
  }

  private prepareArgs(args: string[]): string[] {
    if (args.length === 0) {
      return args;
    }

    const preparedArgs = args.map((arg, index) => {
      if (shouldSkipArgInspection(args[index - 1])) {
        return arg;
      }

      this.detectSecrets(arg, 'argv');
      return replaceKnownValues(
        arg,
        this.vault
          .getSecretToTokenPairs()
          .map(([source, target]) => ({
            source,
            target,
          })),
      ).output;
    });

    return this.options.dryRun ? args : preparedArgs;
  }

  private registerSecretValue(
    secret: string,
    type: SecretType,
    source: 'argv' | 'manual' | 'stdin' | 'proxy',
    options: RegisterSecretValueOptions = {},
  ): RegisteredSecretResult {
    if (source !== 'manual' && this.aisStore?.isExcluded(secret, type)) {
      this.debug(`${source}: skipped excluded secret ${redactSecret(secret)}`);
      return {
        created: false,
        token: secret,
      };
    }

    const previousRevision = this.vault.revision;
    const token = this.vault.register(secret, type, {
      name: options.name,
      source,
    });
    const created = this.vault.revision !== previousRevision;
    this.aisStore?.recordSecret(secret, type, {
      name: options.name,
      source,
    });

    if (created) {
      this.debug(`${source}: detected secret ${redactSecret(secret)} -> ${token}`);
    }

    return { created, token };
  }

  private resetDetectionBuffers(): void {
    this.detectionBuffers.proxy = '';
    this.detectionBuffers.stdin = '';
  }
}

function shouldSkipArgInspection(previousArg?: string): boolean {
  return ['-c', '-e', '-lc', '--command', '--eval'].includes(previousArg ?? '');
}
