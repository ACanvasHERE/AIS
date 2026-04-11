import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { type Readable, type Writable } from 'node:stream';

import * as pty from 'node-pty';

export interface PtyWrapperOptions {
  flushStdinData?: () => string;
  flushStdoutData?: () => string;
  onStdinData?: (data: string) => string;
  onStdoutData?: (data: string) => string;
  stdin?: Readable & {
    isRaw?: boolean;
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  stdout?: Writable & {
    columns?: number;
    isTTY?: boolean;
    rows?: number;
  };
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const require = createRequire(import.meta.url);
const nodePtyPackageDirectory = dirname(require.resolve('node-pty/package.json'));

function identity(data: string): string {
  return data;
}

function empty(): string {
  return '';
}

function getColumns(stdout: PtyWrapperOptions['stdout']): number {
  return stdout?.columns && stdout.columns > 0 ? stdout.columns : DEFAULT_COLUMNS;
}

function getRows(stdout: PtyWrapperOptions['stdout']): number {
  return stdout?.rows && stdout.rows > 0 ? stdout.rows : DEFAULT_ROWS;
}

function forwardSignal(terminal: pty.IPty, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    terminal.kill();
    return;
  }

  terminal.kill(signal);
}

function ensureSpawnHelperExecutable(): void {
  if (process.platform === 'win32') {
    return;
  }

  const candidates = [
    join(nodePtyPackageDirectory, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    join(nodePtyPackageDirectory, 'build', 'Release', 'spawn-helper'),
    join(nodePtyPackageDirectory, 'build', 'Debug', 'spawn-helper'),
  ];

  for (const helperPath of candidates) {
    if (!existsSync(helperPath)) {
      continue;
    }

    const currentMode = statSync(helperPath).mode & 0o777;
    if ((currentMode & 0o111) !== 0) {
      return;
    }

    chmodSync(helperPath, currentMode | 0o755);
    return;
  }
}

export async function runPtyCommand(
  command: string,
  args: string[],
  options: PtyWrapperOptions = {},
): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const flushStdinData = options.flushStdinData ?? empty;
  const flushStdoutData = options.flushStdoutData ?? empty;
  const onStdinData = options.onStdinData ?? identity;
  const onStdoutData = options.onStdoutData ?? identity;
  const env = options.env ?? process.env;

  ensureSpawnHelperExecutable();

  const terminal = pty.spawn(command, args, {
    name: env.TERM ?? 'xterm-color',
    cols: getColumns(stdout),
    rows: getRows(stdout),
    cwd: options.cwd ?? process.cwd(),
    env,
  });

  let cleanedUp = false;
  const wasRawModeEnabled = Boolean(stdin.isRaw);
  const canToggleRawMode = Boolean(stdin.isTTY && typeof stdin.setRawMode === 'function');

  const syncWindowSize = (): void => {
    try {
      terminal.resize(getColumns(stdout), getRows(stdout));
    } catch {
      // Ignore resize failures after the child process has already exited.
    }
  };

  const handleStdinData = (chunk: string | Buffer): void => {
    const nextData = onStdinData(chunk.toString());
    if (nextData.length > 0) {
      terminal.write(nextData);
    }
  };

  const handleStdinEnd = (): void => {
    const nextData = flushStdinData();
    if (nextData.length > 0) {
      terminal.write(nextData);
    }
  };

  const handleSigint = (): void => {
    forwardSignal(terminal, 'SIGINT');
  };

  const handleSigterm = (): void => {
    forwardSignal(terminal, 'SIGTERM');
  };

  const handleSigwinch = (): void => {
    syncWindowSize();
  };

  const stdoutDisposable = terminal.onData((data) => {
    const nextData = onStdoutData(data);
    if (nextData.length > 0) {
      stdout.write(nextData);
    }
  });

  const cleanup = (): void => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    const finalStdout = flushStdoutData();
    if (finalStdout.length > 0) {
      stdout.write(finalStdout);
    }
    stdoutDisposable.dispose();
    stdin.removeListener('data', handleStdinData);
    stdin.removeListener('end', handleStdinEnd);
    process.removeListener('SIGINT', handleSigint);
    process.removeListener('SIGTERM', handleSigterm);
    process.removeListener('SIGWINCH', handleSigwinch);

    if (canToggleRawMode && !wasRawModeEnabled) {
      stdin.setRawMode?.(false);
    }

    stdin.pause();
  };

  stdin.on('data', handleStdinData);
  stdin.on('end', handleStdinEnd);
  stdin.resume();

  if (canToggleRawMode && !wasRawModeEnabled) {
    stdin.setRawMode?.(true);
  }

  process.on('SIGINT', handleSigint);
  process.on('SIGTERM', handleSigterm);
  process.on('SIGWINCH', handleSigwinch);

  try {
    return await new Promise<number>((resolve) => {
      terminal.onExit(({ exitCode }) => {
        cleanup();
        resolve(exitCode);
      });

      syncWindowSize();
    });
  } finally {
    cleanup();
  }
}

export async function createPtyWrapper(
  command: string,
  args: string[],
  options?: PtyWrapperOptions,
): Promise<void> {
  process.exitCode = await runPtyCommand(command, args, options);
}
