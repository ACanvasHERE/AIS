import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAutomationState, saveAutomationState } from './automation/index.js';
import { loadConfig } from './config.js';
import { syncProtectRuntime, type ProtectRuntimeOptions } from './protect/index.js';

export interface PostinstallRunOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  protect?: Omit<ProtectRuntimeOptions, 'env'>;
  stderr?: Pick<typeof process.stderr, 'write'>;
}

export async function runPostinstallHook(options: PostinstallRunOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const stderr = options.stderr ?? process.stderr;

  if (env.npm_config_global !== 'true') {
    return 0;
  }

  try {
    const loadedConfig = await loadConfig(options.configPath);
    const loadedAutomationState = await loadAutomationState(loadedConfig.config.automation.statePath);
    const result = await syncProtectRuntime(loadedConfig.config, loadedAutomationState.state, {
      ...options.protect,
      aisCliPath: options.protect?.aisCliPath ?? fileURLToPath(new URL('./cli.js', import.meta.url)),
      env,
    });

    if (result.changed) {
      await saveAutomationState(result.state, loadedAutomationState.path);
    }

    for (const warning of result.warnings) {
      stderr.write(`${warning}\n`);
    }
    for (const error of result.errors) {
      stderr.write(`${error}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`AIS postinstall skipped takeover setup: ${message}\n`);
  }

  return 0;
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFilePath) {
  const exitCode = await runPostinstallHook();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
