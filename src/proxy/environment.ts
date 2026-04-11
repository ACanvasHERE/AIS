import type { ProxyTargets } from './types.js';

const DEFAULT_TARGETS: ProxyTargets = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
};

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export function getDefaultProxyTargets(env: NodeJS.ProcessEnv = process.env): ProxyTargets {
  return {
    anthropic:
      env.__AIS_REAL_ANTHROPIC_URL ?? env.ANTHROPIC_BASE_URL ?? DEFAULT_TARGETS.anthropic,
    openai: env.__AIS_REAL_OPENAI_URL ?? env.OPENAI_BASE_URL ?? DEFAULT_TARGETS.openai,
  };
}

export function buildProxyEnvironment(
  proxyBaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const resolvedProxyUrl = trimTrailingSlash(proxyBaseUrl);

  return {
    ...env,
    ANTHROPIC_BASE_URL: resolvedProxyUrl,
    OPENAI_BASE_URL: resolvedProxyUrl,
    __AIS_REAL_ANTHROPIC_URL:
      env.__AIS_REAL_ANTHROPIC_URL ??
      env.ANTHROPIC_BASE_URL ??
      DEFAULT_TARGETS.anthropic,
    __AIS_REAL_OPENAI_URL:
      env.__AIS_REAL_OPENAI_URL ?? env.OPENAI_BASE_URL ?? DEFAULT_TARGETS.openai,
  };
}

export { DEFAULT_TARGETS as DEFAULT_PROXY_TARGETS };
