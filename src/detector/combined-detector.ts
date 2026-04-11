import { ContextDetector } from './context-detector.js';
import { EntropyDetector } from './entropy-detector.js';
import { PatternDetector, type CustomPatternDefinition } from './pattern-detector.js';
import type { DetectedSecret, SecretDetector } from './types.js';

export interface CombinedDetectorOptions {
  customPatterns?: CustomPatternDefinition[];
  enablePattern?: boolean;
  enableContext?: boolean;
  enableEntropy?: boolean;
  entropyThreshold?: number;
}

function overlaps(left: DetectedSecret, right: DetectedSecret): boolean {
  return left.start < right.end && right.start < left.end;
}

export class CombinedDetector implements SecretDetector {
  private readonly stages: SecretDetector[];

  constructor(options: CombinedDetectorOptions = {}) {
    this.stages = [];

    if (options.enablePattern !== false) {
      this.stages.push(
        new PatternDetector({
          customPatterns: options.customPatterns,
        }),
      );
    }

    if (options.enableContext !== false) {
      this.stages.push(new ContextDetector());
    }

    if (options.enableEntropy !== false) {
      this.stages.push(
        new EntropyDetector({
          threshold: options.entropyThreshold,
        }),
      );
    }
  }

  detect(input: string): DetectedSecret[] {
    const accepted: DetectedSecret[] = [];

    for (const stage of this.stages) {
      for (const match of stage.detect(input)) {
        if (accepted.some((existing) => overlaps(existing, match))) {
          continue;
        }

        accepted.push(match);
      }
    }

    return accepted.sort((left, right) => left.start - right.start || left.end - right.end);
  }
}
