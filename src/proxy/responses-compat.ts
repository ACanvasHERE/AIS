import { randomUUID } from 'node:crypto';

const DEFAULT_RESPONSES_FALLBACK_MAX_TOKENS = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type ChatMessageRole = 'assistant' | 'system' | 'tool' | 'user';

interface ChatToolCall {
  function: {
    arguments: string;
    name: string;
  };
  id: string;
  type: 'function';
}

export interface ChatMessage {
  content: string | Array<Record<string, unknown>>;
  role: ChatMessageRole;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
}

function normalizeChatRole(role: unknown): ChatMessageRole | undefined {
  if (role === 'assistant' || role === 'system' || role === 'tool' || role === 'user') {
    return role;
  }

  if (role === 'developer') {
    return 'system';
  }

  return undefined;
}

interface StoredResponse {
  messages: ChatMessage[];
  response: Record<string, unknown>;
}

export class ResponsesCompatibilityStore {
  private readonly responses = new Map<string, StoredResponse>();

  getMessages(responseId: string): ChatMessage[] | undefined {
    const stored = this.responses.get(responseId);
    return stored ? cloneValue(stored.messages) : undefined;
  }

  getResponse(responseId: string): Record<string, unknown> | undefined {
    const stored = this.responses.get(responseId);
    return stored ? cloneValue(stored.response) : undefined;
  }

  set(responseId: string, stored: StoredResponse): void {
    this.responses.set(responseId, {
      messages: cloneValue(stored.messages),
      response: cloneValue(stored.response),
    });
  }

  clear(): void {
    this.responses.clear();
  }
}

export interface ResponsesCompatibilityRequest {
  chatRequest: Record<string, unknown>;
  messages: ChatMessage[];
}

export interface ResponsesCompatibilityJsonResult {
  bodyText: string;
  response: Record<string, unknown>;
  responseId: string;
  storedMessages: ChatMessage[];
}

interface ToolState {
  arguments: string;
  callId: string;
  itemId: string;
  name: string;
  outputIndex: number;
}

function toStringValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value === undefined || value === null) {
    return '';
  }

  return JSON.stringify(value);
}

function normalizeContentParts(content: unknown): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return toStringValue(content);
  }

  const parts = content.flatMap((entry): Array<Record<string, unknown>> => {
    if (!isRecord(entry)) {
      const text = toStringValue(entry);
      return text.length > 0 ? [{ type: 'text', text }] : [];
    }

    const type = typeof entry.type === 'string' ? entry.type : '';
    if (type === 'input_text' || type === 'output_text' || type === 'text') {
      const text = toStringValue(entry.text);
      return text.length > 0 ? [{ type: 'text', text }] : [];
    }

    if (type === 'input_image') {
      const imageUrl =
        typeof entry.image_url === 'string'
          ? entry.image_url
          : isRecord(entry.image_url) && typeof entry.image_url.url === 'string'
            ? entry.image_url.url
            : '';
      return imageUrl.length > 0 ? [{ type: 'image_url', image_url: { url: imageUrl } }] : [];
    }

    return [];
  });

  if (parts.length === 0) {
    return '';
  }

  if (parts.every((part) => part.type === 'text')) {
    return parts.map((part) => toStringValue(part.text)).join('');
  }

  return parts;
}

function appendChatMessage(messages: ChatMessage[], message: ChatMessage): void {
  const normalizedContent = normalizeContentParts(message.content);

  if (normalizedContent === '' || (Array.isArray(normalizedContent) && normalizedContent.length === 0)) {
    return;
  }

  messages.push({
    ...message,
    content: normalizedContent,
  });
}

function toJoinedText(content: ChatMessage['content']): string {
  const normalized = normalizeContentParts(content);
  if (typeof normalized === 'string') {
    return normalized;
  }

  return normalized
    .map((entry) => (typeof entry.text === 'string' ? entry.text : ''))
    .filter((entry) => entry.length > 0)
    .join('\n');
}

function mergeAdjacentSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = [];

  messages.forEach((message) => {
    if (message.role !== 'system') {
      merged.push(message);
      return;
    }

    const previous = merged[merged.length - 1];
    if (
      !previous ||
      previous.role !== 'system' ||
      previous.tool_call_id !== undefined ||
      previous.tool_calls !== undefined
    ) {
      merged.push(message);
      return;
    }

    const combined = [toJoinedText(previous.content), toJoinedText(message.content)]
      .filter((entry) => entry.length > 0)
      .join('\n\n');

    previous.content = combined;
  });

  return merged;
}

function appendResponsesInput(messages: ChatMessage[], input: unknown): void {
  if (typeof input === 'string') {
    appendChatMessage(messages, { role: 'user', content: input });
    return;
  }

  if (!Array.isArray(input)) {
    if (input !== undefined && input !== null) {
      appendChatMessage(messages, { role: 'user', content: toStringValue(input) });
    }
    return;
  }

  input.forEach((entry) => {
    if (typeof entry === 'string') {
      appendChatMessage(messages, { role: 'user', content: entry });
      return;
    }

    if (!isRecord(entry)) {
      appendChatMessage(messages, { role: 'user', content: toStringValue(entry) });
      return;
    }

    const role =
      normalizeChatRole(entry.role) ??
      (entry.type === 'message' ? normalizeChatRole(entry.role) : undefined);
    const type = typeof entry.type === 'string' ? entry.type : '';

    if (role) {
      appendChatMessage(messages, {
        role,
        content: normalizeContentParts(entry.content ?? ''),
      });
      return;
    }

    if (type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id:
          typeof entry.call_id === 'string' && entry.call_id.length > 0
            ? entry.call_id
            : `call_${randomUUID().replace(/-/g, '')}`,
        content: toStringValue(entry.output),
      });
      return;
    }

    if (type === 'function_call') {
      const name = typeof entry.name === 'string' ? entry.name : 'tool';
      const callId =
        typeof entry.call_id === 'string' && entry.call_id.length > 0
          ? entry.call_id
          : `call_${randomUUID().replace(/-/g, '')}`;
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: callId,
            type: 'function',
            function: {
              name,
              arguments: toStringValue(entry.arguments),
            },
          },
        ],
      });
      return;
    }

    if (type === 'input_text' || type === 'input_image') {
      appendChatMessage(messages, {
        role: 'user',
        content: [entry],
      });
      return;
    }

    appendChatMessage(messages, {
      role: 'user',
      content: normalizeContentParts(entry.content ?? entry.text ?? entry),
    });
  });
}

function translateTools(tools: unknown): unknown {
  if (!Array.isArray(tools)) {
    return undefined;
  }

  const translated = tools.flatMap((entry) => {
    if (!isRecord(entry) || entry.type !== 'function') {
      return [];
    }

    const name = typeof entry.name === 'string' ? entry.name : '';
    if (name.length === 0) {
      return [];
    }

    return [
      {
        type: 'function',
        function: removeUndefined({
          name,
          description: typeof entry.description === 'string' ? entry.description : undefined,
          parameters: isRecord(entry.parameters) ? entry.parameters : entry.parameters ?? undefined,
          strict: entry.strict === true ? true : undefined,
        }),
      },
    ];
  });

  return translated.length > 0 ? translated : undefined;
}

function translateToolChoice(toolChoice: unknown): unknown {
  if (toolChoice === undefined || toolChoice === null) {
    return undefined;
  }

  if (typeof toolChoice === 'string') {
    return toolChoice;
  }

  if (!isRecord(toolChoice) || toolChoice.type !== 'function') {
    return undefined;
  }

  if (typeof toolChoice.name === 'string') {
    return {
      type: 'function',
      function: {
        name: toolChoice.name,
      },
    };
  }

  if (isRecord(toolChoice.function) && typeof toolChoice.function.name === 'string') {
    return {
      type: 'function',
      function: {
        name: toolChoice.function.name,
      },
    };
  }

  return undefined;
}

function resolveMaxTokens(payload: Record<string, unknown>): number {
  const candidates = [
    payload.max_output_tokens,
    payload.max_completion_tokens,
    payload.max_tokens,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }

  return DEFAULT_RESPONSES_FALLBACK_MAX_TOKENS;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

export function translateResponsesRequest(
  bodyText: string,
  store: ResponsesCompatibilityStore,
): ResponsesCompatibilityRequest {
  const payload = JSON.parse(bodyText) as Record<string, unknown>;
  const previousResponseId =
    typeof payload.previous_response_id === 'string' ? payload.previous_response_id : '';
  const messages =
    previousResponseId.length > 0 ? store.getMessages(previousResponseId) ?? [] : [];

  if (
    messages.length === 0 &&
    typeof payload.instructions === 'string' &&
    payload.instructions.trim().length > 0
  ) {
    appendChatMessage(messages, {
      role: 'system',
      content: payload.instructions,
    });
  }

  appendResponsesInput(messages, payload.input);
  const normalizedMessages = mergeAdjacentSystemMessages(messages);
  const translatedToolChoice = translateToolChoice(payload.tool_choice);

  const chatRequest = removeUndefined({
    messages: normalizedMessages,
    model: payload.model,
    max_tokens: resolveMaxTokens(payload),
    parallel_tool_calls: payload.parallel_tool_calls === true ? true : undefined,
    stream: typeof payload.stream === 'boolean' ? payload.stream : undefined,
    temperature: typeof payload.temperature === 'number' ? payload.temperature : undefined,
    tool_choice: translatedToolChoice === 'auto' ? undefined : translatedToolChoice,
    tools: translateTools(payload.tools),
    top_p: typeof payload.top_p === 'number' ? payload.top_p : undefined,
    user: typeof payload.user === 'string' ? payload.user : undefined,
  });

  return {
    chatRequest,
    messages: normalizedMessages,
  };
}

function buildResponseMessageItem(content: string, itemId: string): Record<string, unknown> {
  return {
    id: itemId,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [
      {
        type: 'output_text',
        text: content,
        annotations: [],
      },
    ],
  };
}

function buildResponseFunctionCallItem(toolCall: ChatToolCall): Record<string, unknown> {
  return {
    id: `fc_${randomUUID().replace(/-/g, '')}`,
    type: 'function_call',
    call_id: toolCall.id,
    name: toolCall.function.name,
    arguments: toolCall.function.arguments,
    status: 'completed',
  };
}

function getAssistantMessage(
  payload: Record<string, unknown>,
): { normalizedText: string; responseItems: Array<Record<string, unknown>>; storedMessage: ChatMessage } {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = choices.find(isRecord);
  const message =
    firstChoice && isRecord(firstChoice.message) ? firstChoice.message : ({} as Record<string, unknown>);
  const textContent = normalizeContentParts(message.content ?? '');
  const storedMessage: ChatMessage = {
    role: 'assistant',
    content: textContent,
  };

  const responseItems: Array<Record<string, unknown>> = [];

  const normalizedText =
    typeof textContent === 'string'
      ? textContent
      : Array.isArray(textContent)
        ? textContent
            .map((entry) => (typeof entry.text === 'string' ? entry.text : ''))
            .filter((entry) => entry.length > 0)
            .join('')
        : '';
  if (normalizedText.length > 0) {
    responseItems.push(buildResponseMessageItem(normalizedText, `msg_${randomUUID().replace(/-/g, '')}`));
  }

  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.filter(isRecord).flatMap((toolCall) => {
        if (!isRecord(toolCall.function) || typeof toolCall.function.name !== 'string') {
          return [];
        }

        return [
          {
            id:
              typeof toolCall.id === 'string' && toolCall.id.length > 0
                ? toolCall.id
                : `call_${randomUUID().replace(/-/g, '')}`,
            type: 'function' as const,
            function: {
              name: toolCall.function.name,
              arguments:
                typeof toolCall.function.arguments === 'string'
                  ? toolCall.function.arguments
                  : toStringValue(toolCall.function.arguments),
            },
          },
        ];
      })
    : [];

  if (toolCalls.length > 0) {
    storedMessage.tool_calls = toolCalls;
    responseItems.push(...toolCalls.map((toolCall) => buildResponseFunctionCallItem(toolCall)));
  }

  return {
    normalizedText,
    responseItems,
    storedMessage,
  };
}

export function translateChatCompletionJsonToResponses(
  bodyText: string,
  messages: ChatMessage[],
): ResponsesCompatibilityJsonResult {
  const payload = JSON.parse(bodyText) as Record<string, unknown>;
  const responseId = `resp_${randomUUID().replace(/-/g, '')}`;
  const { normalizedText, responseItems, storedMessage } = getAssistantMessage(payload);
  const response = {
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: typeof payload.model === 'string' ? payload.model : undefined,
    output: responseItems,
    output_text: normalizedText.length > 0 ? normalizedText : undefined,
    status: 'completed',
  };

  const storedMessages = cloneValue(messages);
  storedMessages.push(storedMessage);

  return {
    bodyText: JSON.stringify(removeUndefined(response)),
    response: removeUndefined(response),
    responseId,
    storedMessages,
  };
}

function createEvent(type: string, extra: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ type, ...extra })}\n\n`;
}

export class ResponsesCompatibilitySseTransformer {
  private buffer = '';
  private contentPartAdded = false;
  private readonly createdAt = Math.floor(Date.now() / 1000);
  private finalized = false;
  private readonly messageItemId = `msg_${randomUUID().replace(/-/g, '')}`;
  private messageOutputIndex: number | null = null;
  private readonly responseId = `resp_${randomUUID().replace(/-/g, '')}`;
  private text = '';
  private readonly toolStates = new Map<number, ToolState>();

  constructor(
    private readonly messages: ChatMessage[],
    private readonly model: string | undefined,
  ) {}

  start(): string {
    return createEvent('response.created', {
      response: {
        id: this.responseId,
        object: 'response',
        created_at: this.createdAt,
        model: this.model,
        output: [],
        output_text: '',
        status: 'in_progress',
      },
    });
  }

  push(chunk: string): string {
    const input = this.buffer + chunk;
    const parts = input.split(/(\r?\n)/);
    const lastPart = parts.pop();
    this.buffer = lastPart ?? '';

    let output = '';
    for (let index = 0; index < parts.length; index += 2) {
      const line = parts[index] ?? '';
      output += this.transformLine(line);
    }

    return output;
  }

  finish(): { output: string; response: Record<string, unknown>; responseId: string; storedMessages: ChatMessage[] } {
    let output = '';
    if (this.buffer.length > 0) {
      output += this.transformLine(this.buffer);
      this.buffer = '';
    }
    output += this.finalize();
    const response = this.buildResponseObject();
    const storedMessages = cloneValue(this.messages);
    storedMessages.push(this.buildAssistantMessage());
    return {
      output,
      response,
      responseId: this.responseId,
      storedMessages,
    };
  }

  private transformLine(line: string): string {
    if (!line.startsWith('data: ')) {
      return '';
    }

    const payloadText = line.slice(6);
    if (payloadText === '[DONE]') {
      return this.finalize();
    }

    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(payloadText) as unknown;
      if (!isRecord(parsed)) {
        return '';
      }
      payload = parsed;
    } catch {
      return '';
    }

    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const choice = choices.find(isRecord);
    if (!choice) {
      return '';
    }

    const delta = isRecord(choice.delta) ? choice.delta : {};
    let output = '';

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      output += this.pushContent(delta.content);
    }

    if (Array.isArray(delta.tool_calls)) {
      delta.tool_calls.filter(isRecord).forEach((toolCall, position) => {
        output += this.pushToolCall(toolCall, position);
      });
    }

    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      output += this.finalize();
    }

    return output;
  }

  private pushContent(delta: string): string {
    this.text += delta;

    if (this.messageOutputIndex === null) {
      this.messageOutputIndex = 0;
      let output = createEvent('response.output_item.added', {
        item: {
          id: this.messageItemId,
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: [],
        },
        output_index: this.messageOutputIndex,
      });
      output += createEvent('response.content_part.added', {
        content_index: 0,
        item_id: this.messageItemId,
        output_index: this.messageOutputIndex,
        part: {
          type: 'output_text',
          text: '',
          annotations: [],
        },
      });
      this.contentPartAdded = true;
      output += createEvent('response.output_text.delta', {
        content_index: 0,
        delta,
        item_id: this.messageItemId,
        output_index: this.messageOutputIndex,
      });
      return output;
    }

    return createEvent('response.output_text.delta', {
      content_index: 0,
      delta,
      item_id: this.messageItemId,
      output_index: this.messageOutputIndex,
    });
  }

  private pushToolCall(toolCall: Record<string, unknown>, position: number): string {
    const index = typeof toolCall.index === 'number' ? toolCall.index : position;
    const existing = this.toolStates.get(index);
    const functionPayload = isRecord(toolCall.function) ? toolCall.function : {};
    const state =
      existing ??
      {
        arguments: '',
        callId:
          typeof toolCall.id === 'string' && toolCall.id.length > 0
            ? toolCall.id
            : `call_${randomUUID().replace(/-/g, '')}`,
        itemId: `fc_${randomUUID().replace(/-/g, '')}`,
        name: typeof functionPayload.name === 'string' ? functionPayload.name : 'tool',
        outputIndex:
          (this.messageOutputIndex === null ? 0 : 1) + Array.from(this.toolStates.keys()).length,
      };

    if (typeof functionPayload.name === 'string' && functionPayload.name.length > 0) {
      state.name = functionPayload.name;
    }

    let output = '';
    if (!existing) {
      output += createEvent('response.output_item.added', {
        item: {
          id: state.itemId,
          type: 'function_call',
          call_id: state.callId,
          name: state.name,
          arguments: '',
          status: 'in_progress',
        },
        output_index: state.outputIndex,
      });
      this.toolStates.set(index, state);
    }

    if (typeof functionPayload.arguments === 'string' && functionPayload.arguments.length > 0) {
      state.arguments += functionPayload.arguments;
      output += createEvent('response.function_call_arguments.delta', {
        delta: functionPayload.arguments,
        item_id: state.itemId,
        output_index: state.outputIndex,
      });
    }

    return output;
  }

  private finalize(): string {
    if (this.finalized) {
      return '';
    }

    this.finalized = true;
    let output = '';

    if (this.messageOutputIndex !== null && this.contentPartAdded) {
      output += createEvent('response.output_text.done', {
        content_index: 0,
        item_id: this.messageItemId,
        output_index: this.messageOutputIndex,
        text: this.text,
      });
      output += createEvent('response.content_part.done', {
        content_index: 0,
        item_id: this.messageItemId,
        output_index: this.messageOutputIndex,
        part: {
          type: 'output_text',
          text: this.text,
          annotations: [],
        },
      });
      output += createEvent('response.output_item.done', {
        item: buildResponseMessageItem(this.text, this.messageItemId),
        output_index: this.messageOutputIndex,
      });
    }

    Array.from(this.toolStates.values())
      .sort((left, right) => left.outputIndex - right.outputIndex)
      .forEach((toolState) => {
        output += createEvent('response.function_call_arguments.done', {
          arguments: toolState.arguments,
          item_id: toolState.itemId,
          output_index: toolState.outputIndex,
        });
        output += createEvent('response.output_item.done', {
          item: {
            id: toolState.itemId,
            type: 'function_call',
            call_id: toolState.callId,
            name: toolState.name,
            arguments: toolState.arguments,
            status: 'completed',
          },
          output_index: toolState.outputIndex,
        });
      });

    output += createEvent('response.completed', {
      response: this.buildResponseObject(),
    });

    return output;
  }

  private buildAssistantMessage(): ChatMessage {
    const toolCalls = Array.from(this.toolStates.values())
      .sort((left, right) => left.outputIndex - right.outputIndex)
      .map((toolState) => ({
        id: toolState.callId,
        type: 'function' as const,
        function: {
          name: toolState.name,
          arguments: toolState.arguments,
        },
      }));

    return {
      role: 'assistant',
      content: this.text,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  }

  private buildResponseObject(): Record<string, unknown> {
    const output: Array<Record<string, unknown>> = [];

    if (this.messageOutputIndex !== null && this.text.length > 0) {
      output.push(buildResponseMessageItem(this.text, this.messageItemId));
    }

    Array.from(this.toolStates.values())
      .sort((left, right) => left.outputIndex - right.outputIndex)
      .forEach((toolState) => {
        output.push({
          id: toolState.itemId,
          type: 'function_call',
          call_id: toolState.callId,
          name: toolState.name,
          arguments: toolState.arguments,
          status: 'completed',
        });
      });

    return removeUndefined({
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      model: this.model,
      output,
      output_text: this.text.length > 0 ? this.text : undefined,
      status: 'completed',
    });
  }
}

export function createResponsesCompatibilityStatusBody(): string {
  return JSON.stringify({
    object: 'response_compatibility',
    mode: 'chat_completions',
    status: 'available',
  });
}
