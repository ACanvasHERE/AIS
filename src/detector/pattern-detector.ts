import type { SecretType } from '../vault/types.js';

import type { DetectedSecret, SecretDetector } from './types.js';

interface PatternDefinition {
  extractValue(match: RegExpMatchArray): string | null;
  id: string;
  type: SecretType;
  expression: RegExp;
}

export interface CustomPatternDefinition {
  id: string;
  regex: string;
  type: SecretType;
}

export interface PatternDetectorOptions {
  customPatterns?: CustomPatternDefinition[];
}

const PRIVATE_KEY_BLOCK_PATTERN =
  /(-----BEGIN ((?:RSA |EC |OPENSSH )?PRIVATE KEY)-----[\s\S]*?-----END \2-----|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/g;
const AWS_SECRET_VALUE_PATTERN = /[A-Za-z0-9/+=]{40}/;

export const KNOWN_SECRET_PATTERNS: PatternDefinition[] = [
  {
    extractValue(match) {
      return match[1] ?? null;
    },
    id: 'anthropic_key',
    type: 'APIKEY',
    expression: /(?<![A-Za-z0-9_-])(sk-ant-api\d{2}-[A-Za-z0-9_-]{80,})(?![A-Za-z0-9_-])/g,
  },
  {
    extractValue(match) {
      return match[1] ?? null;
    },
    id: 'openai_project',
    type: 'APIKEY',
    expression: /(?<![A-Za-z0-9_-])(sk-proj-[A-Za-z0-9_-]{40,})(?![A-Za-z0-9_-])/g,
  },
  {
    extractValue(match) {
      return match[1] ?? null;
    },
    id: 'openai_key',
    type: 'APIKEY',
    expression: /(?<![A-Za-z0-9])(sk-(?!proj-)[A-Za-z0-9]{20,})(?![A-Za-z0-9])/g,
  },
  {
    extractValue(match) {
      return match[1] ?? null;
    },
    id: 'aws_access',
    type: 'APIKEY',
    expression: /(?<![A-Z0-9])((?:AKIA|AGPA|AROA|AIPA)[A-Z0-9]{16})(?![A-Z0-9])/g,
  },
  {
    extractValue(match) {
      return match[1] ?? null;
    },
    id: 'aws_secret',
    type: 'APIKEY',
    expression: new RegExp(
      String.raw`(?:\bAWS_SECRET_ACCESS_KEY\b|\baws_secret_access_key\b)\s*[:=]\s*(${AWS_SECRET_VALUE_PATTERN.source})(?![A-Za-z0-9/+=])`,
      'g',
    ),
  },
  {
    extractValue(match) {
      return match[1] ?? null;
    },
    id: 'aws_secret',
    type: 'APIKEY',
    expression: new RegExp(
      String.raw`(?:AKIA|AGPA|AROA|AIPA)[A-Z0-9]{16}[=:,\s]{1,10}(${AWS_SECRET_VALUE_PATTERN.source})(?![A-Za-z0-9/+=])`,
      'g',
    ),
  },
  {
    extractValue(match) {
      return match[1] ?? null;
    },
    id: 'github_pat',
    type: 'APIKEY',
    expression: /(?<![A-Za-z0-9_])(ghp_[0-9a-zA-Z]{36})(?![A-Za-z0-9_])/g,
  },
  {
    extractValue(match) {
      return match[1] ?? null;
    },
    id: 'stripe_live',
    type: 'APIKEY',
    expression: /(?<![A-Za-z0-9_])(sk_live_[0-9a-zA-Z]{24,})(?![A-Za-z0-9_])/g,
  },
  {
    extractValue(match) {
      return match[1] ?? null;
    },
    id: 'slack_token',
    type: 'APIKEY',
    expression: /(?<![A-Za-z0-9-])(xox[baprs]-[0-9a-zA-Z-]{10,72})(?![A-Za-z0-9-])/g,
  },
  {
    extractValue(match) {
      return match[1] ?? null;
    },
    id: 'jwt_token',
    type: 'JWT',
    expression: /(?<![A-Za-z0-9_-])(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(?![A-Za-z0-9_-])/g,
  },
  {
    extractValue(match) {
      return match[1] ?? null;
    },
    id: 'rsa_private',
    type: 'PRIVATE_KEY',
    expression: PRIVATE_KEY_BLOCK_PATTERN,
  },
  {
    extractValue(match) {
      return match[1] ?? null;
    },
    id: 'db_connection',
    type: 'DBCONN',
    expression: /((?:mysql|postgres(?:ql)?|mongodb|redis):\/\/[^:\s'"]+:[^@\s'"]+@[^\s'"]+)/g,
  },
];

export class PatternDetector implements SecretDetector {
  private readonly patterns: PatternDefinition[];

  constructor(options: PatternDetectorOptions = {}) {
    this.patterns = [
      ...KNOWN_SECRET_PATTERNS,
      ...buildCustomPatterns(options.customPatterns ?? []),
    ];
  }

  detect(input: string): DetectedSecret[] {
    const matches: DetectedSecret[] = [];

    for (const pattern of this.patterns) {
      for (const match of input.matchAll(pattern.expression)) {
        const value = pattern.extractValue(match);
        if (!value || match.index === undefined) {
          continue;
        }

        const start = match.index + match[0].indexOf(value);
        matches.push({
          value,
          type: pattern.type,
          confidence: 'high',
          start,
          end: start + value.length,
          patternId: pattern.id,
        });
      }
    }

    return matches.sort((left, right) => left.start - right.start || left.end - right.end);
  }
}

function buildCustomPatterns(patterns: CustomPatternDefinition[]): PatternDefinition[] {
  return patterns.map((pattern) => ({
    id: pattern.id,
    type: pattern.type,
    expression: new RegExp(pattern.regex, 'g'),
    extractValue(match) {
      return match[0] ?? null;
    },
  }));
}
