interface ReplacementRule {
  source: string;
  target: string;
}

interface ReplacementMatcher {
  findMatches(input: string): Match[];
}

interface TrieNode {
  fail: number;
  next: Map<string, number>;
  outputs: number[];
}

interface Match {
  end: number;
  replacement: string;
  sourceLength: number;
  start: number;
}

const SIMPLE_MATCHER_LIMIT = 10;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sortRules(rules: ReplacementRule[]): ReplacementRule[] {
  return rules.sort((left, right) => {
    if (right.source.length !== left.source.length) {
      return right.source.length - left.source.length;
    }

    return left.source.localeCompare(right.source);
  });
}

class RegexMatcher implements ReplacementMatcher {
  private readonly pattern: RegExp;
  private readonly replacements: Map<string, string>;

  constructor(rules: ReplacementRule[]) {
    this.replacements = new Map(rules.map((rule) => [rule.source, rule.target]));
    this.pattern = new RegExp(rules.map((rule) => escapeRegExp(rule.source)).join('|'), 'g');
  }

  findMatches(input: string): Match[] {
    if (input.length === 0) {
      return [];
    }

    this.pattern.lastIndex = 0;

    return Array.from(input.matchAll(this.pattern), (match) => {
      const value = match[0];
      const start = match.index ?? 0;

      return {
        start,
        end: start + value.length,
        sourceLength: value.length,
        replacement: this.replacements.get(value) ?? value,
      };
    });
  }
}

class SingleRuleMatcher implements ReplacementMatcher {
  constructor(private readonly rule: ReplacementRule) {}

  findMatches(input: string): Match[] {
    if (input.length === 0 || this.rule.source.length === 0) {
      return [];
    }

    const matches: Match[] = [];
    let start = input.indexOf(this.rule.source);

    while (start !== -1) {
      matches.push({
        start,
        end: start + this.rule.source.length,
        sourceLength: this.rule.source.length,
        replacement: this.rule.target,
      });
      start = input.indexOf(this.rule.source, start + this.rule.source.length);
    }

    return matches;
  }
}

class AhoCorasickMatcher implements ReplacementMatcher {
  private readonly nodes: TrieNode[] = [{ fail: 0, next: new Map(), outputs: [] }];
  private readonly rules: ReplacementRule[];

  constructor(rules: ReplacementRule[]) {
    this.rules = rules;
    this.buildTrie();
    this.buildFailureLinks();
  }

  findMatches(input: string): Match[] {
    if (input.length === 0) {
      return [];
    }

    const matches: Match[] = [];
    let nodeIndex = 0;

    for (let position = 0; position < input.length; position += 1) {
      const character = input[position];

      while (nodeIndex !== 0 && !this.nodes[nodeIndex].next.has(character)) {
        nodeIndex = this.nodes[nodeIndex].fail;
      }

      nodeIndex = this.nodes[nodeIndex].next.get(character) ?? 0;

      for (const ruleIndex of this.nodes[nodeIndex].outputs) {
        const rule = this.rules[ruleIndex];
        matches.push({
          start: position - rule.source.length + 1,
          end: position + 1,
          sourceLength: rule.source.length,
          replacement: rule.target,
        });
      }
    }

    return matches;
  }

  private buildTrie(): void {
    this.rules.forEach((rule, ruleIndex) => {
      let nodeIndex = 0;

      for (const character of rule.source) {
        const nextIndex = this.nodes[nodeIndex].next.get(character);

        if (nextIndex !== undefined) {
          nodeIndex = nextIndex;
          continue;
        }

        const createdIndex = this.nodes.length;
        this.nodes.push({ fail: 0, next: new Map(), outputs: [] });
        this.nodes[nodeIndex].next.set(character, createdIndex);
        nodeIndex = createdIndex;
      }

      this.nodes[nodeIndex].outputs.push(ruleIndex);
    });
  }

  private buildFailureLinks(): void {
    const queue: number[] = [];

    for (const childIndex of this.nodes[0].next.values()) {
      this.nodes[childIndex].fail = 0;
      queue.push(childIndex);
    }

    while (queue.length > 0) {
      const currentIndex = queue.shift();

      if (currentIndex === undefined) {
        break;
      }

      const currentNode = this.nodes[currentIndex];

      for (const [character, childIndex] of currentNode.next.entries()) {
        let fallbackIndex = currentNode.fail;

        while (fallbackIndex !== 0 && !this.nodes[fallbackIndex].next.has(character)) {
          fallbackIndex = this.nodes[fallbackIndex].fail;
        }

        const failureTarget = this.nodes[fallbackIndex].next.get(character) ?? 0;
        this.nodes[childIndex].fail = failureTarget;
        this.nodes[childIndex].outputs.push(...this.nodes[failureTarget].outputs);
        queue.push(childIndex);
      }
    }
  }
}

function createMatcher(rules: ReplacementRule[]): ReplacementMatcher | null {
  if (rules.length === 0) {
    return null;
  }

  if (rules.length === 1) {
    return new SingleRuleMatcher(rules[0]);
  }

  if (rules.length < SIMPLE_MATCHER_LIMIT) {
    return new RegexMatcher(rules);
  }

  return new AhoCorasickMatcher(rules);
}

function normalizeRules(replacements: Map<string, string>): ReplacementRule[] {
  return sortRules(
    Array.from(replacements.entries(), ([source, target]) => ({ source, target })).filter(
      (rule) => rule.source.length > 0,
    ),
  );
}

function sortMatches(matches: Match[]): Match[] {
  if (matches.length < 2) {
    return matches;
  }

  return matches.sort((left, right) => {
    if (left.start !== right.start) {
      return left.start - right.start;
    }

    if (right.sourceLength !== left.sourceLength) {
      return right.sourceLength - left.sourceLength;
    }

    return left.end - right.end;
  });
}

function replaceUpTo(input: string, matches: Match[], limit: number): string {
  if (limit <= 0) {
    return '';
  }

  let cursor = 0;
  let result = '';

  for (const match of matches) {
    if (match.start >= limit) {
      break;
    }

    if (match.start < cursor || match.end > limit) {
      continue;
    }

    result += input.slice(cursor, match.start);
    result += match.replacement;
    cursor = match.end;
  }

  return result + input.slice(cursor, limit);
}

export class StreamReplacer {
  private buffer = '';
  private matcher: ReplacementMatcher | null = null;
  private maxPatternLen = 0;
  private prefixes = new Set<string>();

  constructor(replacements: Map<string, string>) {
    this.updateRules(replacements);
  }

  push(chunk: string): string {
    const input = this.buffer + chunk;

    if (this.matcher === null || this.maxPatternLen === 0) {
      this.buffer = '';
      return input;
    }

    const lookbehindLength = this.getLookbehindLength(input);
    const tentativeLimit = input.length - lookbehindLength;

    if (tentativeLimit <= 0) {
      this.buffer = input;
      return '';
    }

    const matches = sortMatches(this.matcher.findMatches(input));
    const safeLimit = this.getSafeLimit(matches, tentativeLimit);

    this.buffer = input.slice(safeLimit);
    return replaceUpTo(input, matches, safeLimit);
  }

  flush(): string {
    if (this.buffer.length === 0) {
      return '';
    }

    const remaining = this.buffer;
    this.buffer = '';

    if (this.matcher === null) {
      return remaining;
    }

    return replaceUpTo(remaining, sortMatches(this.matcher.findMatches(remaining)), remaining.length);
  }

  updateRules(replacements: Map<string, string>): void {
    const rules = normalizeRules(replacements);

    this.maxPatternLen = rules.reduce((currentMax, rule) => Math.max(currentMax, rule.source.length), 0);
    this.prefixes = new Set(
      rules.flatMap((rule) =>
        Array.from({ length: Math.max(0, rule.source.length - 1) }, (_, index) =>
          rule.source.slice(0, index + 1),
        ),
      ),
    );
    this.matcher = createMatcher(rules);
  }

  private getLookbehindLength(input: string): number {
    const longestCandidate = Math.min(input.length, Math.max(0, this.maxPatternLen - 1));

    for (let length = longestCandidate; length > 0; length -= 1) {
      if (this.prefixes.has(input.slice(-length))) {
        return length;
      }
    }

    return 0;
  }

  private getSafeLimit(matches: Match[], tentativeLimit: number): number {
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
}
