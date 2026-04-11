import type { SecretType } from '../vault/types.js';

import type { DetectedSecret, SecretDetector } from './types.js';

interface ContextRule {
  id: string;
  expression: RegExp;
  getType(keyword: string): SecretType;
}

const INLINE_SPACING = String.raw`[^\S\r\n]*`;
const ENGLISH_CONNECTORS = new Set(['and', 'or', 'but']);
const HARD_VALUE_BOUNDARIES = new Set([
  '\n',
  '\r',
  ',',
  ';',
  '\uFF0C',
  '\uFF1B',
  '\u3001',
  ')',
  ']',
  '}',
  '"',
  '\'',
]);

const CONTEXT_RULES: ContextRule[] = [
  {
    id: 'context_cn_keyword',
    expression: new RegExp(
      String.raw`(\u5BC6\u7801|\u5BC6\u94A5|\u53E3\u4EE4)${INLINE_SPACING}(?:\u662F|\u4E3A|=|:|\uFF1A)${INLINE_SPACING}`,
      'g',
    ),
    getType(keyword) {
      return keyword === '\u5BC6\u94A5' ? 'APIKEY' : 'PASSWORD';
    },
  },
  {
    id: 'context_en_keyword',
    expression: new RegExp(
      String.raw`\b(password|passwd|api[_-]?key|token|secret)\b${INLINE_SPACING}(?:=|:|：|is)${INLINE_SPACING}`,
      'gi',
    ),
    getType(keyword) {
      return classifyKeyword(keyword);
    },
  },
  {
    id: 'context_assignment',
    expression: new RegExp(
      String.raw`\b([A-Za-z_][A-Za-z0-9_]*(?:PASSWORD|PASSWD|API_KEY|TOKEN|SECRET)[A-Za-z0-9_]*)\b${INLINE_SPACING}=${INLINE_SPACING}`,
      'g',
    ),
    getType(keyword) {
      return classifyKeyword(keyword);
    },
  },
];

function classifyKeyword(keyword: string): SecretType {
  const normalized = keyword.toLowerCase();

  if (normalized.includes('password') || normalized.includes('passwd') || normalized.includes('\u53E3\u4EE4')) {
    return 'PASSWORD';
  }

  if (normalized.includes('api_key') || normalized.includes('api-key') || normalized.includes('\u5BC6\u94A5')) {
    return 'APIKEY';
  }

  if (normalized.includes('token')) {
    return 'BEARER_TOKEN';
  }

  return 'GENERIC';
}

function isAsciiLetter(character: string): boolean {
  return /[A-Za-z]/.test(character);
}

function isAsciiIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_-]/.test(character);
}

function isHanCharacter(character: string): boolean {
  return /\p{Script=Han}/u.test(character);
}

function skipInlineWhitespace(input: string, start: number): number {
  let cursor = start;

  while (cursor < input.length) {
    const character = input[cursor];
    if (character === '\n' || character === '\r' || !/\s/.test(character)) {
      break;
    }

    cursor += 1;
  }

  return cursor;
}

function readConnector(input: string, start: number): number {
  const lowerRest = input.slice(start).toLowerCase();

  for (const connector of ENGLISH_CONNECTORS) {
    if (!lowerRest.startsWith(connector)) {
      continue;
    }

    const nextCharacter = input[start + connector.length] ?? '';
    if (!isAsciiIdentifierPart(nextCharacter)) {
      return start + connector.length;
    }
  }

  return start;
}

function readFieldName(input: string, start: number): number {
  if (start >= input.length) {
    return start;
  }

  const firstCharacter = input[start];
  if (isAsciiLetter(firstCharacter) || firstCharacter === '_') {
    let cursor = start + 1;
    while (cursor < input.length && isAsciiIdentifierPart(input[cursor])) {
      cursor += 1;
    }

    return cursor;
  }

  if (!isHanCharacter(firstCharacter)) {
    return start;
  }

  let cursor = start + 1;
  while (cursor < input.length && isHanCharacter(input[cursor])) {
    cursor += 1;
  }

  return cursor;
}

function readFieldOperator(input: string, start: number): number {
  const singleCharacterOperator = input[start];
  if (singleCharacterOperator === '=' || singleCharacterOperator === ':' || singleCharacterOperator === '\uFF1A') {
    return start + 1;
  }

  if (singleCharacterOperator === '\u662F' || singleCharacterOperator === '\u4E3A') {
    return start + 1;
  }

  const lowerRest = input.slice(start, start + 2).toLowerCase();
  if (lowerRest === 'is') {
    const nextCharacter = input[start + 2] ?? '';
    if (!isAsciiIdentifierPart(nextCharacter)) {
      return start + 2;
    }
  }

  return start;
}

function startsNextField(input: string, start: number): boolean {
  let cursor = skipInlineWhitespace(input, start);
  if (cursor >= input.length || input[cursor] === '\n' || input[cursor] === '\r') {
    return false;
  }

  const afterConnector = readConnector(input, cursor);
  if (afterConnector > cursor) {
    cursor = skipInlineWhitespace(input, afterConnector);
  }

  const afterFieldName = readFieldName(input, cursor);
  if (afterFieldName === cursor) {
    return false;
  }

  cursor = skipInlineWhitespace(input, afterFieldName);
  const afterOperator = readFieldOperator(input, cursor);

  return afterOperator > cursor;
}

function extractValue(
  input: string,
  start: number,
): {
  end: number;
  value: string;
} | null {
  const openingQuote = input[start];
  if (openingQuote === '"' || openingQuote === '\'') {
    const closingIndex = input.indexOf(openingQuote, start + 1);
    if (closingIndex <= start + 1) {
      return null;
    }

    const quotedValue = input.slice(start + 1, closingIndex);
    if (quotedValue.includes('\n') || quotedValue.includes('\r')) {
      return null;
    }

    return {
      value: quotedValue,
      end: closingIndex + 1,
    };
  }

  let cursor = start;
  while (cursor < input.length) {
    const character = input[cursor];
    if (HARD_VALUE_BOUNDARIES.has(character)) {
      break;
    }

    if (/\s/.test(character) && startsNextField(input, cursor)) {
      break;
    }

    cursor += 1;
  }

  const rawValue = input.slice(start, cursor).trimEnd();
  if (rawValue.length === 0) {
    return null;
  }

  return {
    value: rawValue,
    end: start + rawValue.length,
  };
}

function dedupe(matches: DetectedSecret[]): DetectedSecret[] {
  const seen = new Set<string>();

  return matches.filter((match) => {
    const key = `${match.start}:${match.end}:${match.patternId}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

export class ContextDetector implements SecretDetector {
  detect(input: string): DetectedSecret[] {
    const matches: DetectedSecret[] = [];

    for (const rule of CONTEXT_RULES) {
      for (const match of input.matchAll(rule.expression)) {
        const keyword = match[1];
        if (!keyword || match.index === undefined) {
          continue;
        }

        const start = match.index + match[0].length;
        const value = extractValue(input, start);
        if (!value) {
          continue;
        }

        matches.push({
          value: value.value,
          type: rule.getType(keyword),
          confidence: 'medium',
          start,
          end: value.end,
          patternId: rule.id,
        });
      }
    }

    return dedupe(matches).sort((left, right) => left.start - right.start || left.end - right.end);
  }
}
