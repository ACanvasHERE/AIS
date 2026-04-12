import { parseArgs } from 'node:util';

import { isProtectTool, type ProtectTool } from './automation/index.js';
import { isSecretType, type SecretType } from './vault/types.js';

const KNOWN_SUBCOMMANDS = new Set(['add', 'ais', 'config', 'list', 'protect', 'remove', 'status', 'update']);
const OPTIONS_WITH_VALUES = ['--config', '-c', '--proxy-port'] as const;

export interface CliGlobalOptions {
  config?: string;
  debug: boolean;
  dryRun: boolean;
  help: boolean;
  noContext: boolean;
  noEntropy: boolean;
  proxyPort?: number;
  skipUpdateCheck: boolean;
  version: boolean;
}

export type CliInvocation =
  | { type: 'add'; name: string; options: CliGlobalOptions; secret?: string }
  | {
      action: 'exclude' | 'exclude-type' | 'include' | 'include-type' | 'show';
      options: CliGlobalOptions;
      target?: string;
      type: 'ais';
      secretType?: SecretType;
    }
  | { action: 'get'; key: string; options: CliGlobalOptions; type: 'config' }
  | { action: 'set'; key: string; options: CliGlobalOptions; type: 'config'; value: string }
  | { action: 'show'; options: CliGlobalOptions; type: 'config' }
  | { type: 'error'; message: string }
  | { type: 'help'; options: CliGlobalOptions }
  | { type: 'list'; options: CliGlobalOptions }
  | { action: 'off' | 'on'; options: CliGlobalOptions; target: ProtectTool | 'all'; type: 'protect' }
  | { action: 'restore' | 'status'; options: CliGlobalOptions; type: 'protect' }
  | { type: 'remove'; name: string; options: CliGlobalOptions }
  | { type: 'status'; options: CliGlobalOptions }
  | { type: 'update'; options: CliGlobalOptions }
  | { type: 'version'; options: CliGlobalOptions }
  | { type: 'wrap'; args: string[]; command: string; options: CliGlobalOptions };

export function parseCliInvocation(args: string[]): CliInvocation {
  let optionArgs: string[];
  let remainder: string[];

  try {
    ({ optionArgs, remainder } = splitLeadingGlobalOptions(args));
  } catch (error) {
    return {
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  let parsedOptions: CliGlobalOptions;

  try {
    parsedOptions = parseGlobalOptions(optionArgs);
  } catch (error) {
    return {
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (parsedOptions.help) {
    return {
      type: 'help',
      options: parsedOptions,
    };
  }

  if (parsedOptions.version) {
    return {
      type: 'version',
      options: parsedOptions,
    };
  }

  if (remainder.length === 0) {
    return {
      type: 'error',
      message: 'Missing command. Use --help to see available commands.',
    };
  }

  const [command, ...rest] = remainder;
  if (KNOWN_SUBCOMMANDS.has(command)) {
    return parseSubcommand(command, rest, parsedOptions);
  }

  return {
    type: 'wrap',
    command,
    args: rest,
    options: parsedOptions,
  };
}

function parseGlobalOptions(args: string[]): CliGlobalOptions {
  const { values } = parseArgs({
    args,
    options: {
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
      debug: { type: 'boolean', short: 'd' },
      'dry-run': { type: 'boolean' },
      config: { type: 'string', short: 'c' },
      'no-entropy': { type: 'boolean' },
      'no-context': { type: 'boolean' },
      'proxy-port': { type: 'string' },
      'skip-update-check': { type: 'boolean' },
    },
    allowPositionals: false,
    strict: true,
  });

  return {
    config: values.config,
    debug: values.debug ?? false,
    dryRun: values['dry-run'] ?? false,
    help: values.help ?? false,
    noContext: values['no-context'] ?? false,
    noEntropy: values['no-entropy'] ?? false,
    proxyPort: parseProxyPort(values['proxy-port']),
    skipUpdateCheck: values['skip-update-check'] ?? false,
    version: values.version ?? false,
  };
}

function parseProxyPort(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error('Option --proxy-port requires a numeric value.');
  }

  const parsed = Number.parseInt(value, 10);
  if (parsed < 1 || parsed > 65535) {
    throw new Error('Option --proxy-port must be between 1 and 65535.');
  }

  return parsed;
}

function parseSubcommand(
  command: string,
  args: string[],
  options: CliGlobalOptions,
): CliInvocation {
  switch (command) {
    case 'add':
      if (args.length === 0 || args.length > 2) {
        return {
          type: 'error',
          message: 'Usage: ais add <name> [secret]',
        };
      }

      return {
        type: 'add',
        name: args[0],
        secret: args[1],
        options,
      };

    case 'ais':
      return parseAisSubcommand(args, options);

    case 'list':
      return expectNoExtraArgs(command, args, {
        type: 'list',
        options,
      });

    case 'remove':
      if (args.length !== 1) {
        return {
          type: 'error',
          message: 'Usage: ais remove <name>',
        };
      }

      return {
        type: 'remove',
        name: args[0],
        options,
      };

    case 'status':
      return expectNoExtraArgs(command, args, {
        type: 'status',
        options,
      });

    case 'config':
      return parseConfigSubcommand(args, options);

    case 'protect':
      return parseProtectSubcommand(args, options);

    case 'update':
      return expectNoExtraArgs(command, args, {
        type: 'update',
        options,
      });

    default:
      return {
        type: 'error',
        message: `Unknown subcommand: ${command}`,
      };
  }
}

function expectNoExtraArgs<T extends CliInvocation>(command: string, args: string[], invocation: T): CliInvocation {
  if (args.length > 0) {
    return {
      type: 'error',
      message: `Usage: ais ${command}`,
    };
  }

  return invocation;
}

function parseAisSubcommand(args: string[], options: CliGlobalOptions): CliInvocation {
  if (args.length === 0) {
    return {
      type: 'ais',
      action: 'show',
      options,
    };
  }

  const [action, target] = args;
  if (action === 'show') {
    if (args.length !== 1) {
      return {
        type: 'error',
        message: 'Usage: ais ais show',
      };
    }

    return {
      type: 'ais',
      action: 'show',
      options,
    };
  }

  if (action === 'exclude' || action === 'include') {
    if (args.length !== 2 || !target) {
      return {
        type: 'error',
        message: `Usage: ais ais ${action} <id>`,
      };
    }

    return {
      type: 'ais',
      action,
      options,
      target,
    };
  }

  if (action === 'exclude-type' || action === 'include-type') {
    if (args.length !== 2 || !target) {
      return {
        type: 'error',
        message: `Usage: ais ais ${action} <type>`,
      };
    }

    const normalizedType = target.toUpperCase();
    if (!isSecretType(normalizedType)) {
      return {
        type: 'error',
        message: `Unknown secret type: ${target}`,
      };
    }

    return {
      type: 'ais',
      action,
      options,
      secretType: normalizedType,
      target: normalizedType,
    };
  }

  return {
    type: 'error',
    message: 'Usage: ais ais [show|exclude <id>|include <id>|exclude-type <type>|include-type <type>]',
  };
}

function parseConfigSubcommand(args: string[], options: CliGlobalOptions): CliInvocation {
  if (args.length === 0) {
    return {
      type: 'config',
      action: 'show',
      options,
    };
  }

  const [action, key, value] = args;
  if (action === 'show') {
    if (args.length !== 1) {
      return {
        type: 'error',
        message: 'Usage: ais config show',
      };
    }

    return {
      type: 'config',
      action: 'show',
      options,
    };
  }

  if (action === 'get') {
    if (args.length !== 2 || !key) {
      return {
        type: 'error',
        message: 'Usage: ais config get <key>',
      };
    }

    return {
      type: 'config',
      action: 'get',
      key,
      options,
    };
  }

  if (action === 'set') {
    if (args.length !== 3 || !key || value === undefined) {
      return {
        type: 'error',
        message: 'Usage: ais config set <key> <value>',
      };
    }

    return {
      type: 'config',
      action: 'set',
      key,
      options,
      value,
    };
  }

  return {
    type: 'error',
    message: 'Usage: ais config [show|get <key>|set <key> <value>]',
  };
}

function parseProtectSubcommand(args: string[], options: CliGlobalOptions): CliInvocation {
  if (args.length === 0) {
    return {
      type: 'protect',
      action: 'status',
      options,
    };
  }

  const [action, target] = args;
  if (action === 'status') {
    if (args.length !== 1) {
      return {
        type: 'error',
        message: 'Usage: ais protect status',
      };
    }

    return {
      type: 'protect',
      action: 'status',
      options,
    };
  }

  if (action === 'restore') {
    if (args.length !== 1) {
      return {
        type: 'error',
        message: 'Usage: ais protect restore',
      };
    }

    return {
      type: 'protect',
      action: 'restore',
      options,
    };
  }

  if (action === 'on' || action === 'off') {
    if (args.length !== 2 || !target) {
      return {
        type: 'error',
        message: `Usage: ais protect ${action} <tool|all>`,
      };
    }

    if (target !== 'all' && !isProtectTool(target)) {
      return {
        type: 'error',
        message: `Unknown protect target: ${target}`,
      };
    }

    return {
      type: 'protect',
      action,
      options,
      target,
    };
  }

  return {
    type: 'error',
    message: 'Usage: ais protect [status|on <tool|all>|off <tool|all>|restore]',
  };
}

function splitLeadingGlobalOptions(args: string[]): {
  optionArgs: string[];
  remainder: string[];
} {
  if (args[0] === '--') {
    return {
      optionArgs: [],
      remainder: args.slice(1),
    };
  }

  const optionArgs: string[] = [];
  let index = 0;

  while (index < args.length) {
    const current = args[index];

    if (current === '--') {
      return {
        optionArgs,
        remainder: args.slice(index + 1),
      };
    }

    if (current === '-' || !current.startsWith('-')) {
      break;
    }

    optionArgs.push(current);

    if (expectsSeparateValue(current)) {
      const next = args[index + 1];
      if (!next) {
        throw new Error(`Option ${current} requires a value.`);
      }

      optionArgs.push(next);
      index += 2;
      continue;
    }

    index += 1;
  }

  return {
    optionArgs,
    remainder: args.slice(index),
  };
}

function expectsSeparateValue(arg: string): boolean {
  if (arg.startsWith('--config=')) {
    return false;
  }

  return OPTIONS_WITH_VALUES.includes(arg as (typeof OPTIONS_WITH_VALUES)[number]);
}
