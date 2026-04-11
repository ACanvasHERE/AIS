import type { DetectedSecret, SecretDetector } from './types.js';

const MIN_SECRET_LENGTH = 20;
const HEX_ENTROPY_THRESHOLD = 3.5;
const BASE64_ENTROPY_THRESHOLD = 4.5;

const HEX_CANDIDATE_REGEX = /(?<![A-Fa-f0-9])([A-Fa-f0-9]{20,})(?![A-Fa-f0-9])/g;
const BASE64_CANDIDATE_REGEX = /(?<![A-Za-z0-9+/_-])([A-Za-z0-9+/_-]{20,}={0,2})(?![A-Za-z0-9+/_-])/g;

export interface EntropyDetectorOptions {
  threshold?: number;
}

function calculateShannonEntropy(value: string): number {
  const counts = new Map<string, number>();

  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }

  return entropy;
}

function countCharacterGroups(value: string): number {
  return [
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /\d/.test(value),
    /[+/_=-]/.test(value),
  ].filter(Boolean).length;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isVersion(value: string): boolean {
  return /^v?\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/.test(value);
}

function isGitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

function isUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(value);
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isVariableName(value: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(value) || /^[a-z_][a-z0-9_]*$/.test(value);
}

function isWhitelisted(value: string): boolean {
  return (
    isUuid(value) ||
    isVersion(value) ||
    isGitSha(value) ||
    isUrl(value) ||
    isEmail(value) ||
    isVariableName(value)
  );
}

function detectFromRegex(
  input: string,
  expression: RegExp,
  patternId: string,
  threshold: number,
  isValidCandidate: (value: string) => boolean,
): DetectedSecret[] {
  const matches: DetectedSecret[] = [];

  for (const match of input.matchAll(expression)) {
    const value = match[1];
    if (!value || match.index === undefined) {
      continue;
    }

    if (value.length < MIN_SECRET_LENGTH || isWhitelisted(value) || !isValidCandidate(value)) {
      continue;
    }

    if (calculateShannonEntropy(value) <= threshold) {
      continue;
    }

    const start = match.index + match[0].indexOf(value);
    matches.push({
      value,
      type: 'GENERIC',
      confidence: 'low',
      start,
      end: start + value.length,
      patternId,
    });
  }

  return matches;
}

function isHexCandidate(value: string): boolean {
  return /^[A-Fa-f0-9]+$/.test(value) && !isGitSha(value);
}

function isBase64Candidate(value: string): boolean {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    return false;
  }

  return countCharacterGroups(value) >= 3;
}

function dedupe(matches: DetectedSecret[]): DetectedSecret[] {
  const seen = new Set<string>();

  return matches.filter((match) => {
    const key = `${match.start}:${match.end}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

export class EntropyDetector implements SecretDetector {
  constructor(private readonly options: EntropyDetectorOptions = {}) {}

  detect(input: string): DetectedSecret[] {
    const threshold = this.options.threshold;
    const matches = [
      ...detectFromRegex(
        input,
        HEX_CANDIDATE_REGEX,
        'entropy_hex',
        threshold ?? HEX_ENTROPY_THRESHOLD,
        isHexCandidate,
      ),
      ...detectFromRegex(
        input,
        BASE64_CANDIDATE_REGEX,
        'entropy_base64',
        threshold ?? BASE64_ENTROPY_THRESHOLD,
        isBase64Candidate,
      ),
    ];

    return dedupe(matches).sort((left, right) => left.start - right.start || left.end - right.end);
  }
}

export { calculateShannonEntropy };
