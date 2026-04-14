import {
  createServer,
  request as createHttpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type RequestOptions,
  type Server,
  type ServerResponse,
  STATUS_CODES,
} from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { request as createHttpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';

import { StreamReplacer } from '../interceptor/stream-replacer.js';
import { SessionVault } from '../vault/session-vault.js';

import { getDefaultProxyTargets } from './environment.js';
import {
  type ChatMessage,
  createResponsesCompatibilityStatusBody,
  ResponsesCompatibilitySseTransformer,
  ResponsesCompatibilityStore,
  translateChatCompletionJsonToResponses,
  translateResponsesRequest,
} from './responses-compat.js';
import { relayWebSocket } from './websocket-relay.js';
import type { ProxyProvider, ProxyTargets } from './types.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 18080;
const DEFAULT_PUBLIC_HOST = 'localhost';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_PORT_ATTEMPTS = 20;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const WEBSOCKET_REQUEST_HEADERS_TO_DROP = new Set([
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'sec-websocket-extensions',
  'te',
  'trailer',
  'transfer-encoding',
]);

const CAPTURE_REDACTED_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
]);

interface TextFieldTemplate {
  apply: (payload: unknown, value: string) => void;
  payload: unknown;
}

interface ResolvedTarget {
  provider: ProxyProvider;
  url: URL;
}

interface SseTrackedField {
  apply: (value: string) => void;
  key: string;
  template: TextFieldTemplate;
  value: string;
}

export interface ProxyOptions {
  captureDir?: string;
  defaultProvider?: ProxyProvider;
  host?: string;
  maxPortAttempts?: number;
  onRequestText?: (body: string) => void;
  port?: number;
  publicHost?: string;
  targetBaseUrl?: string;
  targets?: Partial<ProxyTargets>;
  timeoutMs?: number;
  vault: SessionVault;
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getFirstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function isTextBasedContentType(headers: IncomingHttpHeaders): boolean {
  const contentType = getFirstHeaderValue(headers['content-type'])?.toLowerCase();
  if (!contentType) {
    return true;
  }

  return (
    contentType.startsWith('text/') ||
    contentType.includes('application/json') ||
    contentType.includes('+json') ||
    contentType.includes('application/x-ndjson')
  );
}

function isSseResponse(headers: IncomingHttpHeaders): boolean {
  const contentType = getFirstHeaderValue(headers['content-type'])?.toLowerCase();
  return contentType?.includes('text/event-stream') ?? false;
}

function copyHeaders(
  headers: IncomingHttpHeaders,
  options: { preserveUpgradeHeaders?: boolean } = {},
): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};

  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = key.toLowerCase();
    const keepUpgradeHeader =
      options.preserveUpgradeHeaders === true &&
      (normalizedKey === 'connection' || normalizedKey === 'upgrade');

    if (value === undefined || (HOP_BY_HOP_HEADERS.has(normalizedKey) && !keepUpgradeHeader)) {
      continue;
    }

    result[key] = value;
  }

  return result;
}

function buildUpstreamHeaders(
  headers: IncomingHttpHeaders,
  targetUrl: URL,
  body: Buffer,
): OutgoingHttpHeaders {
  const result = copyHeaders(headers);
  result.host = targetUrl.host;
  result['accept-encoding'] = 'identity';

  if (body.length > 0) {
    result['content-length'] = String(body.length);
  } else {
    delete result['content-length'];
  }

  return result;
}

function stripResponsesCompatibilityHeaders(headers: OutgoingHttpHeaders): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'openai-beta') {
      continue;
    }

    result[key] = value;
  }

  return result;
}

function normalizeHeadersForCapture(
  headers: IncomingHttpHeaders | OutgoingHttpHeaders,
): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => {
        if (CAPTURE_REDACTED_HEADERS.has(key.toLowerCase())) {
          return [key, '<redacted>'];
        }

        if (Array.isArray(value)) {
          return [key, value.map((entry) => String(entry))];
        }

        return [key, String(value)];
      }),
  );
}

function parseJsonForCapture(text: string): unknown {
  if (text.length === 0) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

interface ResponsesCompatibilityCaptureContext {
  clientHeaders: Record<string, string | string[]>;
  clientPath: string;
  clientRequestBody: unknown;
  translatedRequestBody: unknown;
  translatedRequestHeaders: Record<string, string | string[]>;
  translatedUpstreamUrl: string;
}

function buildUpstreamWebSocketHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const result = copyHeaders(headers, { preserveUpgradeHeaders: true });
  result['accept-encoding'] = 'identity';
  result.connection = getFirstHeaderValue(headers.connection) ?? 'Upgrade';
  result.upgrade = getFirstHeaderValue(headers.upgrade) ?? 'websocket';

  for (const key of WEBSOCKET_REQUEST_HEADERS_TO_DROP) {
    delete result[key];
  }

  return result;
}

function buildClientHeaders(
  headers: IncomingHttpHeaders,
  contentLength?: number,
): OutgoingHttpHeaders {
  const result = copyHeaders(headers);

  if (contentLength === undefined) {
    delete result['content-length'];
  } else {
    result['content-length'] = String(contentLength);
  }

  return result;
}

function formatRawHeaderLines(headers: OutgoingHttpHeaders): string {
  let output = '';

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      value.forEach((entry) => {
        output += `${key}: ${entry}\r\n`;
      });
      continue;
    }

    output += `${key}: ${String(value)}\r\n`;
  }

  return output;
}

function writeRawHttpResponse(options: {
  body?: Buffer;
  headers?: OutgoingHttpHeaders;
  socket: Duplex;
  statusCode: number;
  statusMessage: string;
  version?: string;
}): void {
  const {
    body = Buffer.alloc(0),
    headers = {},
    socket,
    statusCode,
    statusMessage,
    version = '1.1',
  } = options;
  const headerBlock = formatRawHeaderLines(headers);
  socket.write(`HTTP/${version} ${statusCode} ${statusMessage}\r\n${headerBlock}\r\n`);
  if (body.length > 0) {
    socket.write(body);
  }
}

function buildUpstreamUrl(baseUrl: string, requestPath: string): URL {
  const base = new URL(baseUrl);
  const requestUrl = new URL(requestPath, 'http://ais.local');
  const normalizedBasePath = base.pathname.endsWith('/')
    ? base.pathname.slice(0, -1)
    : base.pathname;

  if (
    normalizedBasePath.length > 0 &&
    (requestUrl.pathname === normalizedBasePath || requestUrl.pathname.startsWith(`${normalizedBasePath}/`))
  ) {
    base.pathname = requestUrl.pathname;
  } else {
    base.pathname = `${normalizedBasePath}${requestUrl.pathname}`.replace(/\/{2,}/g, '/');
  }
  base.search = requestUrl.search;

  return base;
}

function shouldPrefixOpenAiV1(baseUrl: string, requestPath: string): boolean {
  const base = new URL(baseUrl);
  const normalizedBasePath = base.pathname.endsWith('/')
    ? base.pathname.slice(0, -1)
    : base.pathname;
  const lowerPath = requestPath.toLowerCase();

  if (lowerPath.startsWith('/v1/')) {
    return false;
  }

  const openAiResponsesPath =
    lowerPath === '/responses' ||
    lowerPath.startsWith('/responses/') ||
    lowerPath.startsWith('/chat/') ||
    lowerPath.startsWith('/completions') ||
    lowerPath.startsWith('/embeddings') ||
    lowerPath.startsWith('/audio');

  if (!openAiResponsesPath) {
    return false;
  }

  return normalizedBasePath === '/v1' || base.hostname === 'api.openai.com';
}

function buildProviderUpstreamUrl(
  provider: ProxyProvider,
  baseUrl: string,
  requestPath: string,
): URL {
  if (provider === 'openai' && shouldPrefixOpenAiV1(baseUrl, requestPath)) {
    return buildUpstreamUrl(baseUrl, `/v1${requestPath}`);
  }

  return buildUpstreamUrl(baseUrl, requestPath);
}

function normalizeRequestPath(value: string): string {
  if (value.length === 0) {
    return '/';
  }

  return value.startsWith('/') ? value : `/${value}`;
}

function isResponsesCompatibilityRoot(path: string): boolean {
  const lowerPath = path.toLowerCase();
  return lowerPath === '/v1/responses' || lowerPath === '/responses';
}

function getResponsesCompatibilityResponseId(path: string): string | null {
  const lowerPath = path.toLowerCase();
  const match = lowerPath.match(/^\/(?:v1\/)?responses\/([^/]+)$/);
  return match ? match[1] : null;
}

function stripProviderPrefix(path: string, provider: ProxyProvider): string {
  const prefix = `/${provider}`;

  if (path === prefix) {
    return '/';
  }

  if (path.startsWith(`${prefix}/`)) {
    return path.slice(prefix.length);
  }

  return path;
}

function resolveConfiguredTargets(options: ProxyOptions): ProxyTargets {
  const targets = {
    ...getDefaultProxyTargets(),
    ...options.targets,
  };

  if (options.targetBaseUrl) {
    targets.anthropic = options.targetBaseUrl;
    targets.openai = options.targetBaseUrl;
  }

  return targets;
}

function resolveProvider(
  request: IncomingMessage,
  targets: ProxyTargets,
  defaultProvider?: ProxyProvider,
): ResolvedTarget {
  const requestPath = normalizeRequestPath(request.url ?? '/');

  if (requestPath === '/health') {
    throw new Error('Health requests should not be resolved as upstream targets');
  }

  const anthropicTarget = stripProviderPrefix(requestPath, 'anthropic') !== requestPath;
  if (anthropicTarget) {
    return {
      provider: 'anthropic',
      url: buildProviderUpstreamUrl('anthropic', targets.anthropic, stripProviderPrefix(requestPath, 'anthropic')),
    };
  }

  const openAiTarget = stripProviderPrefix(requestPath, 'openai') !== requestPath;
  if (openAiTarget) {
    return {
      provider: 'openai',
      url: buildProviderUpstreamUrl('openai', targets.openai, stripProviderPrefix(requestPath, 'openai')),
    };
  }

  const lowerPath = requestPath.toLowerCase();
  const anthropicHeadersPresent =
    getFirstHeaderValue(request.headers['anthropic-version']) !== undefined ||
    getFirstHeaderValue(request.headers['x-api-key']) !== undefined;
  const openAiHeadersPresent =
    getFirstHeaderValue(request.headers.authorization) !== undefined ||
    getFirstHeaderValue(request.headers['openai-organization']) !== undefined ||
    getFirstHeaderValue(request.headers['openai-beta']) !== undefined;

  if (anthropicHeadersPresent) {
    return {
      provider: 'anthropic',
      url: buildProviderUpstreamUrl('anthropic', targets.anthropic, requestPath),
    };
  }

  if (openAiHeadersPresent) {
    return {
      provider: 'openai',
      url: buildProviderUpstreamUrl('openai', targets.openai, requestPath),
    };
  }

  if (lowerPath.startsWith('/v1/messages') || lowerPath.startsWith('/v1/complete')) {
    return {
      provider: 'anthropic',
      url: buildProviderUpstreamUrl('anthropic', targets.anthropic, requestPath),
    };
  }

  if (
    lowerPath.startsWith('/v1/chat/') ||
    lowerPath.startsWith('/v1/completions') ||
    lowerPath.startsWith('/v1/responses') ||
    lowerPath.startsWith('/responses') ||
    lowerPath.startsWith('/v1/embeddings') ||
    lowerPath.startsWith('/v1/audio')
  ) {
    return {
      provider: 'openai',
      url: buildProviderUpstreamUrl('openai', targets.openai, requestPath),
    };
  }

  if (defaultProvider) {
    return {
      provider: defaultProvider,
      url: buildProviderUpstreamUrl(defaultProvider, targets[defaultProvider], requestPath),
    };
  }

  throw new Error(`Unable to determine upstream provider for request path: ${requestPath}`);
}

function applyWholeBodyReplacement(body: Buffer, replacements: Map<string, string>): Buffer {
  if (body.length === 0 || replacements.size === 0) {
    return body;
  }

  const replacer = new StreamReplacer(replacements);
  const replaced = replacer.push(body.toString('utf8')) + replacer.flush();

  return Buffer.from(replaced, 'utf8');
}

class SseFieldReplacer {
  private buffer = '';
  private readonly prefixes: Set<string>;
  private readonly sources: string[];

  constructor(private readonly replacements: Map<string, string>) {
    this.sources = Array.from(replacements.keys()).sort((left, right) => {
      if (right.length !== left.length) {
        return right.length - left.length;
      }

      return left.localeCompare(right);
    });
    this.prefixes = new Set(
      this.sources.flatMap((source) =>
        Array.from({ length: Math.max(0, source.length - 1) }, (_, index) =>
          source.slice(0, index + 1),
        ),
      ),
    );
  }

  push(chunk: string): string {
    const input = this.buffer + chunk;

    if (this.sources.length === 0) {
      this.buffer = '';
      return input;
    }

    const tentativeLimit = input.length - this.getLookbehindLength(input);
    if (tentativeLimit <= 0) {
      this.buffer = input;
      return '';
    }

    const safeLimit = this.getSafeLimit(input, tentativeLimit);
    this.buffer = input.slice(safeLimit);

    return this.replaceText(input.slice(0, safeLimit));
  }

  flush(): string {
    if (this.buffer.length === 0) {
      return '';
    }

    const value = this.replaceText(this.buffer);
    this.buffer = '';
    return value;
  }

  private getLookbehindLength(input: string): number {
    const longestCandidate = Math.min(
      input.length,
      Math.max(0, ...this.sources.map((source) => source.length - 1)),
    );

    for (let length = longestCandidate; length > 0; length -= 1) {
      if (this.prefixes.has(input.slice(-length))) {
        return length;
      }
    }

    return 0;
  }

  private getSafeLimit(input: string, tentativeLimit: number): number {
    let safeLimit = tentativeLimit;
    let changed = true;

    while (changed) {
      changed = false;

      for (const source of this.sources) {
        const searchFrom = Math.min(input.length - 1, Math.max(0, safeLimit - 1));
        const matchStart = input.lastIndexOf(source, searchFrom);

        if (matchStart !== -1 && matchStart < safeLimit && matchStart + source.length > safeLimit) {
          safeLimit = matchStart;
          changed = true;
        }
      }
    }

    return safeLimit;
  }

  private replaceText(value: string): string {
    if (value.length === 0) {
      return '';
    }

    return applyWholeBodyReplacement(Buffer.from(value, 'utf8'), this.replacements).toString('utf8');
  }
}

function setAnthropicTrackedField(payload: Record<string, unknown>, field: string, value: string): void {
  if (field === 'completion') {
    payload.completion = value;
    return;
  }

  const [containerKey, nestedKey] = field.split('.');
  const container = payload[containerKey];
  if (!isRecord(container)) {
    return;
  }

  container[nestedKey] = value;
}

function clearAnthropicTrackedFields(payload: Record<string, unknown>): void {
  if (typeof payload.completion === 'string') {
    payload.completion = '';
  }

  if (isRecord(payload.delta) && typeof payload.delta.text === 'string') {
    payload.delta.text = '';
  }

  if (isRecord(payload.delta) && typeof payload.delta.partial_json === 'string') {
    payload.delta.partial_json = '';
  }

  if (isRecord(payload.content_block) && typeof payload.content_block.text === 'string') {
    payload.content_block.text = '';
  }
}

function createAnthropicFields(payload: Record<string, unknown>): SseTrackedField[] {
  const tracked: SseTrackedField[] = [];
  const index = typeof payload.index === 'number' ? payload.index : 0;

  const createTemplate = (field: string): TextFieldTemplate => {
    const templatePayload = cloneJsonValue(payload);
    clearAnthropicTrackedFields(templatePayload);

    return {
      payload: templatePayload,
      apply: (draft, value) => {
        if (!isRecord(draft)) {
          return;
        }

        setAnthropicTrackedField(draft, field, value);
      },
    };
  };

  if (isRecord(payload.delta) && typeof payload.delta.text === 'string') {
    tracked.push({
      key: `anthropic:${index}:delta.text`,
      value: payload.delta.text,
      apply: (value) => {
        if (isRecord(payload.delta)) {
          payload.delta.text = value;
        }
      },
      template: createTemplate('delta.text'),
    });
  }

  if (isRecord(payload.delta) && typeof payload.delta.partial_json === 'string') {
    tracked.push({
      key: `anthropic:${index}:delta.partial_json`,
      value: payload.delta.partial_json,
      apply: (value) => {
        if (isRecord(payload.delta)) {
          payload.delta.partial_json = value;
        }
      },
      template: createTemplate('delta.partial_json'),
    });
  }

  if (isRecord(payload.content_block) && typeof payload.content_block.text === 'string') {
    tracked.push({
      key: `anthropic:${index}:content_block.text`,
      value: payload.content_block.text,
      apply: (value) => {
        if (isRecord(payload.content_block)) {
          payload.content_block.text = value;
        }
      },
      template: createTemplate('content_block.text'),
    });
  }

  if (typeof payload.completion === 'string') {
    tracked.push({
      key: 'anthropic:completion',
      value: payload.completion,
      apply: (value) => {
        payload.completion = value;
      },
      template: createTemplate('completion'),
    });
  }

  return tracked;
}

function clearOpenAiTrackedFields(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload.choices)) {
    return;
  }

  payload.choices.forEach((choice) => {
    if (!isRecord(choice)) {
      return;
    }

    if (typeof choice.text === 'string') {
      choice.text = '';
    }

    if (isRecord(choice.delta) && typeof choice.delta.content === 'string') {
      choice.delta.content = '';
    }

    if (
      isRecord(choice.delta) &&
      isRecord(choice.delta.function_call) &&
      typeof choice.delta.function_call.arguments === 'string'
    ) {
      choice.delta.function_call.arguments = '';
    }

    if (isRecord(choice.delta) && Array.isArray(choice.delta.tool_calls)) {
      choice.delta.tool_calls.forEach((toolCall) => {
        if (!isRecord(toolCall) || !isRecord(toolCall.function)) {
          return;
        }

        if (typeof toolCall.function.arguments === 'string') {
          toolCall.function.arguments = '';
        }
      });
    }
  });
}

function setOpenAiTrackedField(
  payload: Record<string, unknown>,
  choiceIndex: number,
  fieldPath: string,
  value: string,
): void {
  if (!Array.isArray(payload.choices)) {
    return;
  }

  const choice = payload.choices.find((item, index) => {
    if (!isRecord(item)) {
      return false;
    }

    if (typeof item.index === 'number') {
      return item.index === choiceIndex;
    }

    return index === choiceIndex;
  });

  if (!isRecord(choice)) {
    return;
  }

  if (fieldPath === 'text') {
    choice.text = value;
    return;
  }

  if (fieldPath === 'delta.content') {
    if (isRecord(choice.delta)) {
      choice.delta.content = value;
    }

    return;
  }

  if (fieldPath === 'delta.function_call.arguments') {
    if (isRecord(choice.delta) && isRecord(choice.delta.function_call)) {
      choice.delta.function_call.arguments = value;
    }

    return;
  }

  const toolCallMatch = fieldPath.match(/^delta\.tool_calls\.(\d+)\.function\.arguments$/);
  if (!toolCallMatch) {
    return;
  }

  const toolCallIndex = Number(toolCallMatch[1]);
  if (!isRecord(choice.delta) || !Array.isArray(choice.delta.tool_calls)) {
    return;
  }

  const toolCall = choice.delta.tool_calls[toolCallIndex];
  if (!isRecord(toolCall) || !isRecord(toolCall.function)) {
    return;
  }

  toolCall.function.arguments = value;
}

function createOpenAiFields(payload: Record<string, unknown>): SseTrackedField[] {
  if (!Array.isArray(payload.choices)) {
    return [];
  }

  const tracked: SseTrackedField[] = [];

  payload.choices.forEach((choice, position) => {
    if (!isRecord(choice)) {
      return;
    }

    const choiceIndex = typeof choice.index === 'number' ? choice.index : position;
    const createTemplate = (fieldPath: string): TextFieldTemplate => {
      const templatePayload = cloneJsonValue(payload);
      clearOpenAiTrackedFields(templatePayload);

      return {
        payload: templatePayload,
        apply: (draft, value) => {
          if (!isRecord(draft)) {
            return;
          }

          setOpenAiTrackedField(draft, choiceIndex, fieldPath, value);
        },
      };
    };

    if (typeof choice.text === 'string') {
      tracked.push({
        key: `openai:${choiceIndex}:text`,
        value: choice.text,
        apply: (value) => {
          choice.text = value;
        },
        template: createTemplate('text'),
      });
    }

    if (isRecord(choice.delta) && typeof choice.delta.content === 'string') {
      tracked.push({
        key: `openai:${choiceIndex}:delta.content`,
        value: choice.delta.content,
        apply: (value) => {
          if (isRecord(choice.delta)) {
            choice.delta.content = value;
          }
        },
        template: createTemplate('delta.content'),
      });
    }

    if (
      isRecord(choice.delta) &&
      isRecord(choice.delta.function_call) &&
      typeof choice.delta.function_call.arguments === 'string'
    ) {
      tracked.push({
        key: `openai:${choiceIndex}:delta.function_call.arguments`,
        value: choice.delta.function_call.arguments,
        apply: (value) => {
          if (isRecord(choice.delta) && isRecord(choice.delta.function_call)) {
            choice.delta.function_call.arguments = value;
          }
        },
        template: createTemplate('delta.function_call.arguments'),
      });
    }

    if (isRecord(choice.delta) && Array.isArray(choice.delta.tool_calls)) {
      choice.delta.tool_calls.forEach((toolCall, toolCallIndex) => {
        if (!isRecord(toolCall) || !isRecord(toolCall.function)) {
          return;
        }

        if (typeof toolCall.function.arguments !== 'string') {
          return;
        }

        tracked.push({
          key: `openai:${choiceIndex}:delta.tool_calls.${toolCallIndex}.function.arguments`,
          value: toolCall.function.arguments,
          apply: (value) => {
            if (
              isRecord(choice.delta) &&
              Array.isArray(choice.delta.tool_calls) &&
              isRecord(choice.delta.tool_calls[toolCallIndex]) &&
              isRecord(choice.delta.tool_calls[toolCallIndex].function)
            ) {
              choice.delta.tool_calls[toolCallIndex].function.arguments = value;
            }
          },
          template: createTemplate(`delta.tool_calls.${toolCallIndex}.function.arguments`),
        });
      });
    }
  });

  return tracked;
}

class SseTransformer {
  private buffer = '';
  private readonly replacers = new Map<string, SseFieldReplacer>();
  private readonly templates = new Map<string, TextFieldTemplate>();

  constructor(
    private readonly provider: ProxyProvider,
    private readonly replacements: Map<string, string>,
  ) {}

  push(chunk: string): string {
    const input = this.buffer + chunk;
    const parts = input.split(/(\r?\n)/);
    const lastPart = parts.pop();
    this.buffer = lastPart ?? '';

    let output = '';

    for (let index = 0; index < parts.length; index += 2) {
      const line = parts[index] ?? '';
      const separator = parts[index + 1] ?? '';
      output += this.transformLine(line) + separator;
    }

    return output;
  }

  flush(): string {
    let output = '';

    if (this.buffer.length > 0) {
      output += this.transformLine(this.buffer);
      this.buffer = '';
    }

    for (const [key, replacer] of this.replacers.entries()) {
      const remaining = replacer.flush();
      if (remaining.length === 0) {
        continue;
      }

      const template = this.templates.get(key);
      if (!template) {
        continue;
      }

      const payload = cloneJsonValue(template.payload);
      template.apply(payload, remaining);
      output += `data: ${JSON.stringify(payload)}\n\n`;
    }

    return output;
  }

  private getFields(payload: Record<string, unknown>): SseTrackedField[] {
    if (this.provider === 'anthropic') {
      return createAnthropicFields(payload);
    }

    return createOpenAiFields(payload);
  }

  private getReplacer(key: string): SseFieldReplacer {
    const existing = this.replacers.get(key);
    if (existing) {
      return existing;
    }

    const created = new SseFieldReplacer(this.replacements);
    this.replacers.set(key, created);
    return created;
  }

  private transformLine(line: string): string {
    if (!line.startsWith('data:')) {
      return line;
    }

    const prefix = line.startsWith('data: ') ? 'data: ' : 'data:';
    const payload = line.slice(prefix.length);

    if (payload === '[DONE]') {
      return line;
    }

    try {
      const parsed = JSON.parse(payload) as unknown;
      if (!isRecord(parsed)) {
        return line;
      }

      const fields = this.getFields(parsed);
      if (fields.length === 0) {
        return line;
      }

      fields.forEach((field) => {
        const replacer = this.getReplacer(field.key);
        const replaced = replacer.push(field.value);
        field.apply(replaced);
        this.templates.set(field.key, field.template);
      });

      return `${prefix}${JSON.stringify(parsed)}`;
    } catch {
      return line;
    }
  }
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    request.once('end', () => {
      resolve(Buffer.concat(chunks));
    });
    request.once('error', reject);
    request.once('aborted', () => {
      reject(new Error('Client request was aborted'));
    });
  });
}

function sendProxyError(response: ServerResponse, statusCode: number, message: string): void {
  const body = JSON.stringify({ error: message });

  response.writeHead(statusCode, {
    'content-length': String(Buffer.byteLength(body)),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(body);
}

export class ProxyServer {
  private activePort: number | null = null;
  private readonly activeUpgradeSockets = new Set<Duplex>();
  private readonly captureDir?: string;
  private readonly defaultProvider?: ProxyProvider;
  private readonly host: string;
  private readonly maxPortAttempts: number;
  private readonly port: number;
  private readonly publicHost: string;
  private readonly responsesCompatibilityStore = new ResponsesCompatibilityStore();
  private server: Server | null = null;
  private readonly targets: ProxyTargets;
  private readonly timeoutMs: number;

  constructor(private readonly options: ProxyOptions) {
    this.captureDir = options.captureDir ?? process.env.AIS_PROXY_CAPTURE_DIR;
    this.defaultProvider = options.defaultProvider;
    this.host = options.host ?? DEFAULT_HOST;
    this.maxPortAttempts = options.maxPortAttempts ?? DEFAULT_MAX_PORT_ATTEMPTS;
    this.port = options.port ?? DEFAULT_PORT;
    this.publicHost = options.publicHost ?? DEFAULT_PUBLIC_HOST;
    this.targets = resolveConfiguredTargets(options);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  getBaseUrl(): string {
    const currentPort = this.activePort ?? this.port;
    return `http://${this.publicHost}:${currentPort}`;
  }

  async start(): Promise<number> {
    if (this.server && this.activePort !== null) {
      return this.activePort;
    }

    let nextPort = this.port;
    let attemptsRemaining = this.maxPortAttempts;

    while (attemptsRemaining > 0) {
      const server = createServer((request, response) => {
        void this.handleRequest(request, response);
      });
      server.on('upgrade', (request, socket, head) => {
        void this.handleUpgrade(request, socket, head);
      });

      try {
        const listeningPort = await new Promise<number>((resolve, reject) => {
          const onError = (error: Error & { code?: string }) => {
            server.removeListener('listening', onListening);
            reject(error);
          };
          const onListening = () => {
            server.removeListener('error', onError);
            const address = server.address() as AddressInfo | null;
            resolve(address?.port ?? nextPort);
          };

          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(nextPort, this.host);
        });

        this.server = server;
        this.activePort = listeningPort;
        return listeningPort;
      } catch (error) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });

        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        if (code !== 'EADDRINUSE') {
          throw error;
        }

        attemptsRemaining -= 1;
        nextPort += 1;
      }
    }

    throw new Error(`Unable to start proxy after ${this.maxPortAttempts} port attempts`);
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;
    this.activePort = null;

    for (const socket of this.activeUpgradeSockets) {
      socket.destroy();
    }
    this.activeUpgradeSockets.clear();
    this.responsesCompatibilityStore.clear();

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private async handleUpgrade(
    request: IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const path = normalizeRequestPath(request.url ?? '/');

    if (path === '/health') {
      this.sendUpgradeError(clientSocket, 400, 'Health requests do not support upgrade');
      clientSocket.end();
      return;
    }

    let target: ResolvedTarget;
    try {
      target = resolveProvider(request, this.targets, this.defaultProvider);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to resolve upstream target';
      this.sendUpgradeError(clientSocket, 502, message);
      clientSocket.end();
      return;
    }

    const requestFactory = target.url.protocol === 'https:' ? createHttpsRequest : createHttpRequest;
    const headers = buildUpstreamWebSocketHeaders(request.headers);
    headers.host = target.url.host;

    const requestOptions: RequestOptions = {
      headers,
      hostname: target.url.hostname,
      method: request.method ?? 'GET',
      path: `${target.url.pathname}${target.url.search}`,
      port: target.url.port ? Number(target.url.port) : undefined,
      protocol: target.url.protocol,
    };

    clientSocket.once('error', () => undefined);

    await new Promise<void>((resolve) => {
      let settled = false;
      const upstreamRequest = requestFactory(requestOptions);

      upstreamRequest.setTimeout(this.timeoutMs, () => {
        upstreamRequest.destroy(new Error(`Upstream request timed out after ${this.timeoutMs}ms`));
      });

      upstreamRequest.once('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
        if (settled) {
          return;
        }

        settled = true;
        this.trackUpgradeSocket(clientSocket);
        this.trackUpgradeSocket(upstreamSocket);
        writeRawHttpResponse({
          headers: copyHeaders(upstreamResponse.headers, { preserveUpgradeHeaders: true }),
          socket: clientSocket,
          statusCode: upstreamResponse.statusCode ?? 101,
          statusMessage:
            upstreamResponse.statusMessage ?? STATUS_CODES[upstreamResponse.statusCode ?? 101] ?? 'Switching Protocols',
          version: upstreamResponse.httpVersion,
        });

        relayWebSocket({
          clientHead: head,
          clientSocket,
          clientToUpstreamReplacements: new Map(this.options.vault.getSecretToTokenPairs()),
          upstreamHead,
          upstreamSocket,
          upstreamToClientReplacements: new Map(this.options.vault.getTokenToSecretPairs()),
        });
        resolve();
      });

      upstreamRequest.once('response', (upstreamResponse) => {
        if (settled) {
          return;
        }

        settled = true;
        void this.forwardUpgradeFallbackResponse(upstreamResponse, clientSocket)
          .catch((error) => {
            if (!clientSocket.destroyed) {
              clientSocket.destroy(error instanceof Error ? error : undefined);
            }
          })
          .finally(resolve);
      });

      upstreamRequest.once('error', (error) => {
        if (settled) {
          return;
        }

        settled = true;
        const isTimeout = error.message.includes('timed out');
        this.sendUpgradeError(clientSocket, isTimeout ? 504 : 502, error.message);
        clientSocket.end();
        resolve();
      });

      upstreamRequest.end();
    });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = normalizeRequestPath(request.url ?? '/');

    if (path === '/health') {
      const body = JSON.stringify({ ok: true });
      response.writeHead(200, {
        'content-length': String(Buffer.byteLength(body)),
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(body);
      return;
    }

    let target: ResolvedTarget;
    try {
      target = resolveProvider(request, this.targets, this.defaultProvider);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to resolve upstream target';
      sendProxyError(response, 502, message);
      return;
    }

    if (target.provider === 'openai') {
      const handledRead = this.handleResponsesCompatibilityRead(request, response, path);
      if (handledRead) {
        return;
      }
    }

    try {
      const originalBody = await readRequestBody(request);
      const requestBody =
        originalBody.length > 0 && isTextBasedContentType(request.headers)
          ? this.inspectAndMaskTextBody(originalBody)
          : originalBody;

      if (
        target.provider === 'openai' &&
        request.method === 'POST' &&
        isResponsesCompatibilityRoot(path)
      ) {
        await this.forwardResponsesRequestWithFallback(request, response, target, requestBody);
        return;
      }

      await this.forwardRequest(request, response, target, requestBody);
    } catch (error) {
      if (!response.headersSent) {
        const message = error instanceof Error ? error.message : 'Proxy request failed';
        sendProxyError(response, 502, message);
      } else if (!response.writableEnded) {
        response.destroy(error instanceof Error ? error : undefined);
      }
    }
  }

  private handleResponsesCompatibilityRead(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): boolean {
    if (request.method !== 'GET') {
      return false;
    }

    if (isResponsesCompatibilityRoot(path)) {
      const body = createResponsesCompatibilityStatusBody();
      response.writeHead(200, {
        'content-length': String(Buffer.byteLength(body)),
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(body);
      return true;
    }

    const responseId = getResponsesCompatibilityResponseId(path);
    if (!responseId) {
      return false;
    }

    const storedResponse = this.responsesCompatibilityStore.getResponse(responseId);
    if (!storedResponse) {
      sendProxyError(response, 404, `Unknown compatibility response id: ${responseId}`);
      return true;
    }

    const body = JSON.stringify(storedResponse);
    response.writeHead(200, {
      'content-length': String(Buffer.byteLength(body)),
      'content-type': 'application/json; charset=utf-8',
    });
    response.end(body);
    return true;
  }

  private async forwardResponsesRequestWithFallback(
    clientRequest: IncomingMessage,
    clientResponse: ServerResponse,
    target: ResolvedTarget,
    body: Buffer,
  ): Promise<void> {
    const requestFactory =
      target.url.protocol === 'https:' ? createHttpsRequest : createHttpRequest;
    const directHeaders = buildUpstreamHeaders(clientRequest.headers, target.url, body);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const upstreamRequest = requestFactory(
        {
          headers: directHeaders,
          hostname: target.url.hostname,
          method: clientRequest.method,
          path: `${target.url.pathname}${target.url.search}`,
          port: target.url.port ? Number(target.url.port) : undefined,
          protocol: target.url.protocol,
        },
        (upstreamResponse) => {
          const statusCode = upstreamResponse.statusCode ?? 200;
          const shouldFallback =
            statusCode >= 400 && (statusCode === 404 || statusCode === 405 || statusCode === 500);

          if (!shouldFallback) {
            void this.forwardResponse(target.provider, upstreamResponse, clientResponse)
              .then(() => {
                settled = true;
                resolve();
              })
              .catch((error) => {
                settled = true;
                reject(error);
              });
            return;
          }

          upstreamResponse.resume();
          void this.forwardTranslatedResponsesCompatibilityRequest(
            clientRequest,
            clientResponse,
            target,
            body,
          )
            .then(() => {
              settled = true;
              resolve();
            })
            .catch((error) => {
              settled = true;
              reject(error);
            });
        },
      );

      upstreamRequest.setTimeout(this.timeoutMs, () => {
        upstreamRequest.destroy(new Error(`Upstream request timed out after ${this.timeoutMs}ms`));
      });

      upstreamRequest.once('error', (error) => {
        if (settled) {
          return;
        }

        const isTimeout = error.message.includes('timed out');
        if (!clientResponse.headersSent) {
          sendProxyError(clientResponse, isTimeout ? 504 : 502, error.message);
        }

        reject(error);
      });

      upstreamRequest.write(body);
      upstreamRequest.end();
    });
  }

  private async forwardTranslatedResponsesCompatibilityRequest(
    clientRequest: IncomingMessage,
    clientResponse: ServerResponse,
    target: ResolvedTarget,
    body: Buffer,
  ): Promise<void> {
    const translated = translateResponsesRequest(body.toString('utf8'), this.responsesCompatibilityStore);
    const upstreamUrl = new URL(target.url.toString());
    upstreamUrl.pathname = upstreamUrl.pathname.replace(/\/responses$/, '/chat/completions');
    upstreamUrl.search = '';

    const requestFactory =
      upstreamUrl.protocol === 'https:' ? createHttpsRequest : createHttpRequest;
    const translatedBodyText = JSON.stringify(translated.chatRequest);
    const upstreamBody = Buffer.from(translatedBodyText, 'utf8');
    const headers = stripResponsesCompatibilityHeaders(
      buildUpstreamHeaders(clientRequest.headers, upstreamUrl, upstreamBody),
    );
    const captureContext: ResponsesCompatibilityCaptureContext | undefined = this.captureDir
      ? {
          clientHeaders: normalizeHeadersForCapture(clientRequest.headers),
          clientPath: clientRequest.url ?? '/',
          clientRequestBody: parseJsonForCapture(body.toString('utf8')),
          translatedRequestBody: parseJsonForCapture(translatedBodyText),
          translatedRequestHeaders: normalizeHeadersForCapture(headers),
          translatedUpstreamUrl: upstreamUrl.toString(),
        }
      : undefined;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const upstreamRequest = requestFactory(
        {
          headers,
          hostname: upstreamUrl.hostname,
          method: 'POST',
          path: upstreamUrl.pathname,
          port: upstreamUrl.port ? Number(upstreamUrl.port) : undefined,
          protocol: upstreamUrl.protocol,
        },
        (upstreamResponse) => {
          void this.forwardResponsesCompatibilityResponse(
            upstreamResponse,
            clientResponse,
            translated.messages,
            typeof translated.chatRequest.model === 'string' ? translated.chatRequest.model : undefined,
            captureContext,
          )
            .then(() => {
              settled = true;
              resolve();
            })
            .catch((error) => {
              settled = true;
              reject(error);
            });
        },
      );

      upstreamRequest.setTimeout(this.timeoutMs, () => {
        upstreamRequest.destroy(new Error(`Upstream request timed out after ${this.timeoutMs}ms`));
      });

      upstreamRequest.once('error', (error) => {
        if (settled) {
          return;
        }

        const isTimeout = error.message.includes('timed out');
        if (!clientResponse.headersSent) {
          sendProxyError(clientResponse, isTimeout ? 504 : 502, error.message);
        }

        reject(error);
      });

      upstreamRequest.write(upstreamBody);
      upstreamRequest.end();
    });
  }

  private async forwardResponsesCompatibilityResponse(
    upstreamResponse: IncomingMessage,
    clientResponse: ServerResponse,
    messages: ChatMessage[],
    model: string | undefined,
    captureContext?: ResponsesCompatibilityCaptureContext,
  ): Promise<void> {
    const upstreamStatusCode = upstreamResponse.statusCode ?? 200;
    const tokenToSecret = new Map(this.options.vault.getTokenToSecretPairs());

    if (isSseResponse(upstreamResponse.headers)) {
      const headers = buildClientHeaders(
        {
          ...upstreamResponse.headers,
          'content-type': 'text/event-stream; charset=utf-8',
        },
      );
      clientResponse.writeHead(upstreamStatusCode, headers);

      const restoreTransformer = new SseTransformer('openai', tokenToSecret);
      const transformer = new ResponsesCompatibilitySseTransformer(messages, model);
      clientResponse.write(transformer.start());
      const rawChunks: string[] = [];

      await new Promise<void>((resolve, reject) => {
        upstreamResponse.on('data', (chunk: Buffer | string) => {
          const rawChunk = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
          rawChunks.push(rawChunk);
          const restoredChunk = restoreTransformer.push(rawChunk);
          const output = restoredChunk.length > 0 ? transformer.push(restoredChunk) : '';
          if (output.length > 0) {
            clientResponse.write(output);
          }
        });

        upstreamResponse.once('end', () => {
          void (async () => {
            const restoredTail = restoreTransformer.flush();
            if (restoredTail.length > 0) {
              const restoredOutput = transformer.push(restoredTail);
              if (restoredOutput.length > 0) {
                clientResponse.write(restoredOutput);
              }
            }
            const finalized = transformer.finish();
            if (captureContext) {
              await this.writeResponsesCompatibilityCapture(captureContext, {
                responseBody: rawChunks.join(''),
                responseHeaders: normalizeHeadersForCapture(upstreamResponse.headers),
                responseStatusCode: upstreamStatusCode,
              });
            }

            if (finalized.output.length > 0) {
              clientResponse.write(finalized.output);
            }
            this.responsesCompatibilityStore.set(finalized.responseId, {
              messages: finalized.storedMessages,
              response: finalized.response,
            });
            clientResponse.end();
            resolve();
          })().catch(reject);
        });
        upstreamResponse.once('error', reject);
      });
      return;
    }

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      upstreamResponse.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      upstreamResponse.once('end', resolve);
      upstreamResponse.once('error', reject);
    });

    const rawBodyText = Buffer.concat(chunks).toString('utf8');
    if (captureContext) {
      await this.writeResponsesCompatibilityCapture(captureContext, {
        responseBody: rawBodyText,
        responseHeaders: normalizeHeadersForCapture(upstreamResponse.headers),
        responseStatusCode: upstreamStatusCode,
      });
    }

    const restoredBodyText = applyWholeBodyReplacement(
      Buffer.from(rawBodyText, 'utf8'),
      tokenToSecret,
    ).toString('utf8');

    if (upstreamStatusCode >= 400) {
      clientResponse.writeHead(upstreamStatusCode, {
        'content-length': String(Buffer.byteLength(restoredBodyText)),
        'content-type':
          getFirstHeaderValue(upstreamResponse.headers['content-type']) ??
          'application/json; charset=utf-8',
      });
      clientResponse.end(restoredBodyText);
      return;
    }

    const translated = translateChatCompletionJsonToResponses(restoredBodyText, messages);
    this.responsesCompatibilityStore.set(translated.responseId, {
      messages: translated.storedMessages,
      response: translated.response,
    });
    clientResponse.writeHead(upstreamStatusCode, {
      'content-length': String(Buffer.byteLength(translated.bodyText)),
      'content-type': 'application/json; charset=utf-8',
    });
    clientResponse.end(translated.bodyText);
  }

  private async forwardUpgradeFallbackResponse(
    upstreamResponse: IncomingMessage,
    clientSocket: Duplex,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      upstreamResponse.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      upstreamResponse.once('end', resolve);
      upstreamResponse.once('error', reject);
    });

    const tokenToSecret = new Map(this.options.vault.getTokenToSecretPairs());
    const body = isTextBasedContentType(upstreamResponse.headers)
      ? applyWholeBodyReplacement(Buffer.concat(chunks), tokenToSecret)
      : Buffer.concat(chunks);
    const headers = buildClientHeaders(upstreamResponse.headers, body.length);
    writeRawHttpResponse({
      body,
      headers,
      socket: clientSocket,
      statusCode: upstreamResponse.statusCode ?? 502,
      statusMessage: upstreamResponse.statusMessage ?? 'Bad Gateway',
      version: upstreamResponse.httpVersion,
    });
    clientSocket.end();
  }

  private sendUpgradeError(socket: Duplex, statusCode: number, message: string): void {
    const body = Buffer.from(JSON.stringify({ error: message }), 'utf8');
    writeRawHttpResponse({
      body,
      headers: {
        'content-length': String(body.length),
        'content-type': 'application/json; charset=utf-8',
      },
      socket,
      statusCode,
      statusMessage:
        statusCode === 400 ? 'Bad Request' : statusCode === 504 ? 'Gateway Timeout' : 'Bad Gateway',
    });
  }

  private trackUpgradeSocket(socket: Duplex): void {
    this.activeUpgradeSockets.add(socket);
    socket.once('close', () => {
      this.activeUpgradeSockets.delete(socket);
    });
  }

  private async forwardRequest(
    clientRequest: IncomingMessage,
    clientResponse: ServerResponse,
    target: ResolvedTarget,
    body: Buffer,
  ): Promise<void> {
    const requestFactory = target.url.protocol === 'https:' ? createHttpsRequest : createHttpRequest;
    const headers = buildUpstreamHeaders(clientRequest.headers, target.url, body);

    const requestOptions: RequestOptions = {
      headers,
      hostname: target.url.hostname,
      method: clientRequest.method,
      path: `${target.url.pathname}${target.url.search}`,
      port: target.url.port ? Number(target.url.port) : undefined,
      protocol: target.url.protocol,
    };

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const upstreamRequest = requestFactory(requestOptions, (upstreamResponse) => {
        const closeUpstream = () => {
          if (!clientResponse.writableEnded && !upstreamResponse.destroyed) {
            upstreamResponse.destroy();
          }
        };

        clientRequest.once('aborted', closeUpstream);
        clientResponse.once('close', closeUpstream);

        void this.forwardResponse(target.provider, upstreamResponse, clientResponse)
          .then(() => {
            settled = true;
            resolve();
          })
          .catch((error) => {
            settled = true;
            reject(error);
          });
      });

      upstreamRequest.setTimeout(this.timeoutMs, () => {
        upstreamRequest.destroy(new Error(`Upstream request timed out after ${this.timeoutMs}ms`));
      });

      upstreamRequest.once('error', (error) => {
        if (settled) {
          return;
        }

        const isTimeout = error.message.includes('timed out');
        if (!clientResponse.headersSent) {
          sendProxyError(clientResponse, isTimeout ? 504 : 502, error.message);
        }

        reject(error);
      });

      if (body.length > 0) {
        upstreamRequest.write(body);
      }

      upstreamRequest.end();
    });
  }

  private async forwardResponse(
    provider: ProxyProvider,
    upstreamResponse: IncomingMessage,
    clientResponse: ServerResponse,
  ): Promise<void> {
    const tokenToSecret = new Map(this.options.vault.getTokenToSecretPairs());

    if (isSseResponse(upstreamResponse.headers)) {
      const headers = buildClientHeaders(upstreamResponse.headers);
      clientResponse.writeHead(upstreamResponse.statusCode ?? 200, headers);

      const transformer = new SseTransformer(provider, tokenToSecret);
      await new Promise<void>((resolve, reject) => {
        upstreamResponse.on('data', (chunk: Buffer | string) => {
          const output = transformer.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
          if (output.length > 0) {
            clientResponse.write(output);
          }
        });

        upstreamResponse.once('end', () => {
          const remaining = transformer.flush();
          if (remaining.length > 0) {
            clientResponse.write(remaining);
          }

          clientResponse.end();
          resolve();
        });
        upstreamResponse.once('error', reject);
      });

      return;
    }

    if (!isTextBasedContentType(upstreamResponse.headers)) {
      clientResponse.writeHead(
        upstreamResponse.statusCode ?? 200,
        buildClientHeaders(upstreamResponse.headers),
      );

      await new Promise<void>((resolve, reject) => {
        upstreamResponse.on('data', (chunk) => {
          clientResponse.write(chunk);
        });
        upstreamResponse.once('end', () => {
          clientResponse.end();
          resolve();
        });
        upstreamResponse.once('error', reject);
      });

      return;
    }

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      upstreamResponse.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      upstreamResponse.once('end', resolve);
      upstreamResponse.once('error', reject);
    });

    const body = applyWholeBodyReplacement(Buffer.concat(chunks), tokenToSecret);
    const headers = buildClientHeaders(upstreamResponse.headers, body.length);
    clientResponse.writeHead(upstreamResponse.statusCode ?? 200, headers);
    clientResponse.end(body);
  }

  private inspectAndMaskTextBody(body: Buffer): Buffer {
    const text = body.toString('utf8');
    this.options.onRequestText?.(text);

    return applyWholeBodyReplacement(
      Buffer.from(text, 'utf8'),
      new Map(this.options.vault.getSecretToTokenPairs()),
    );
  }

  private async writeResponsesCompatibilityCapture(
    context: ResponsesCompatibilityCaptureContext,
    response: {
      responseBody: string;
      responseHeaders: Record<string, string | string[]>;
      responseStatusCode: number;
    },
  ): Promise<void> {
    if (!this.captureDir) {
      return;
    }

    try {
      await mkdir(this.captureDir, { recursive: true });
      const outputPath = join(
        this.captureDir,
        `responses-compat-${Date.now()}-${randomUUID().replace(/-/g, '')}.json`,
      );
      const payload = {
        clientHeaders: context.clientHeaders,
        clientPath: context.clientPath,
        clientRequestBody: context.clientRequestBody,
        responseBody: parseJsonForCapture(response.responseBody),
        responseHeaders: response.responseHeaders,
        responseStatusCode: response.responseStatusCode,
        translatedRequestBody: context.translatedRequestBody,
        translatedRequestHeaders: context.translatedRequestHeaders,
        translatedUpstreamUrl: context.translatedUpstreamUrl,
      };

      await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch {
      // 证据落盘失败不能影响真实转发。
    }
  }
}
