import type { SecretType } from '../vault/types.js';

export type DetectionConfidence = 'high' | 'medium' | 'low';

export interface DetectedSecret {
  value: string;
  type: SecretType;
  confidence: DetectionConfidence;
  start: number;
  end: number;
  patternId: string;
}

export interface SecretDetector {
  detect(input: string): DetectedSecret[];
}
