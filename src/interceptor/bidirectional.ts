import { SessionVault } from '../vault/session-vault.js';

import { StreamReplacer } from './stream-replacer.js';

export interface BidirectionalFlushResult {
  apiResponse: string;
  input: string;
  output: string;
}

function buildReplacementMap(pairs: Array<[string, string]>): Map<string, string> {
  return new Map(pairs);
}

export class BidirectionalInterceptor {
  private readonly apiResponseReplacer = new StreamReplacer(new Map());
  private readonly inputReplacer = new StreamReplacer(new Map());
  private readonly outputReplacer = new StreamReplacer(new Map());
  private syncedRevision = -1;

  constructor(private readonly vault: SessionVault) {
    this.updateRules();
  }

  processInput(chunk: string): string {
    this.syncRules();
    return this.inputReplacer.push(chunk);
  }

  processOutput(chunk: string): string {
    this.syncRules();
    return this.outputReplacer.push(chunk);
  }

  processApiResponse(chunk: string): string {
    this.syncRules();
    return this.apiResponseReplacer.push(chunk);
  }

  flush(): BidirectionalFlushResult {
    this.syncRules();

    return {
      input: this.inputReplacer.flush(),
      output: this.outputReplacer.flush(),
      apiResponse: this.apiResponseReplacer.flush(),
    };
  }

  updateRules(): void {
    const secretToToken = buildReplacementMap(this.vault.getSecretToTokenPairs());
    const tokenToSecret = buildReplacementMap(this.vault.getTokenToSecretPairs());

    this.inputReplacer.updateRules(secretToToken);
    this.outputReplacer.updateRules(tokenToSecret);
    this.apiResponseReplacer.updateRules(tokenToSecret);
    this.syncedRevision = this.vault.revision;
  }

  private syncRules(): void {
    if (this.syncedRevision === this.vault.revision) {
      return;
    }

    this.updateRules();
  }
}
