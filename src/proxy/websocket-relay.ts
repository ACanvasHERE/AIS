import type { Duplex } from 'node:stream';

import { StreamReplacer } from '../interceptor/stream-replacer.js';

interface ParsedWebSocketFrame {
  firstByte: number;
  masked: boolean;
  maskingKey?: Buffer;
  opcode: number;
  payload: Buffer;
  rawLength: number;
}

export interface WebSocketRelayOptions {
  clientHead?: Buffer;
  clientSocket: Duplex;
  clientToUpstreamReplacements: Map<string, string>;
  upstreamHead?: Buffer;
  upstreamSocket: Duplex;
  upstreamToClientReplacements: Map<string, string>;
}

function applyMask(payload: Buffer, maskingKey: Buffer): void {
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] ^= maskingKey[index % 4];
  }
}

function buildFrame(frame: ParsedWebSocketFrame, payload: Buffer): Buffer {
  let headerLength = 2;

  if (payload.length >= 126 && payload.length <= 0xffff) {
    headerLength += 2;
  } else if (payload.length > 0xffff) {
    headerLength += 8;
  }

  if (frame.masked) {
    headerLength += 4;
  }

  const output = Buffer.alloc(headerLength + payload.length);
  output[0] = frame.firstByte;

  let offset = 2;
  if (payload.length < 126) {
    output[1] = (frame.masked ? 0x80 : 0) | payload.length;
  } else if (payload.length <= 0xffff) {
    output[1] = (frame.masked ? 0x80 : 0) | 126;
    output.writeUInt16BE(payload.length, offset);
    offset += 2;
  } else {
    output[1] = (frame.masked ? 0x80 : 0) | 127;
    output.writeBigUInt64BE(BigInt(payload.length), offset);
    offset += 8;
  }

  if (frame.masked) {
    const maskingKey = frame.maskingKey ?? Buffer.from([0, 0, 0, 0]);
    maskingKey.copy(output, offset);
    offset += 4;
  }

  payload.copy(output, offset);
  if (frame.masked && frame.maskingKey) {
    applyMask(output.subarray(offset), frame.maskingKey);
  }

  return output;
}

function parseFrame(input: Buffer): ParsedWebSocketFrame | null {
  if (input.length < 2) {
    return null;
  }

  const firstByte = input[0];
  const secondByte = input[1];
  const masked = Boolean(secondByte & 0x80);
  const payloadLengthCode = secondByte & 0x7f;
  let offset = 2;
  let payloadLength = 0;

  if (payloadLengthCode < 126) {
    payloadLength = payloadLengthCode;
  } else if (payloadLengthCode === 126) {
    if (input.length < offset + 2) {
      return null;
    }

    payloadLength = input.readUInt16BE(offset);
    offset += 2;
  } else {
    if (input.length < offset + 8) {
      return null;
    }

    payloadLength = Number(input.readBigUInt64BE(offset));
    offset += 8;
  }

  let maskingKey: Buffer | undefined;
  if (masked) {
    if (input.length < offset + 4) {
      return null;
    }

    maskingKey = Buffer.from(input.subarray(offset, offset + 4));
    offset += 4;
  }

  if (input.length < offset + payloadLength) {
    return null;
  }

  const payload = Buffer.from(input.subarray(offset, offset + payloadLength));
  if (maskingKey) {
    applyMask(payload, maskingKey);
  }

  return {
    firstByte,
    masked,
    maskingKey,
    opcode: firstByte & 0x0f,
    payload,
    rawLength: offset + payloadLength,
  };
}

class TextFrameTransformer {
  private buffer = Buffer.alloc(0);
  private readonly replacer: StreamReplacer;
  private withinTextMessage = false;

  constructor(replacements: Map<string, string>) {
    this.replacer = new StreamReplacer(replacements);
  }

  push(chunk: Buffer): Buffer {
    this.buffer =
      this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);

    const output: Buffer[] = [];

    while (true) {
      const frame = parseFrame(this.buffer);
      if (!frame) {
        break;
      }

      this.buffer = this.buffer.subarray(frame.rawLength);
      output.push(this.transformFrame(frame));
    }

    return output.length === 0 ? Buffer.alloc(0) : Buffer.concat(output);
  }

  flush(): Buffer {
    this.buffer = Buffer.alloc(0);
    this.withinTextMessage = false;
    this.replacer.flush();

    return Buffer.alloc(0);
  }

  private transformFrame(frame: ParsedWebSocketFrame): Buffer {
    const textFrame = frame.opcode === 0x1 || (frame.opcode === 0x0 && this.withinTextMessage);
    if (!textFrame) {
      return buildFrame(frame, frame.payload);
    }

    const finalChunk = Boolean(frame.firstByte & 0x80);
    let transformed = this.replacer.push(frame.payload.toString('utf8'));

    if (finalChunk) {
      transformed += this.replacer.flush();
      this.withinTextMessage = false;
    } else {
      this.withinTextMessage = true;
    }

    return buildFrame(frame, Buffer.from(transformed, 'utf8'));
  }
}

function forwardFrames(
  source: Duplex,
  target: Duplex,
  transformer: TextFrameTransformer,
  head?: Buffer,
): void {
  const writeChunk = (chunk: Buffer) => {
    const output = transformer.push(chunk);
    if (output.length > 0) {
      target.write(output);
    }
  };

  if (head && head.length > 0) {
    writeChunk(head);
  }

  source.on('data', (chunk: Buffer | string) => {
    writeChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  source.once('end', () => {
    const remaining = transformer.flush();
    if (remaining.length > 0) {
      target.write(remaining);
    }

    target.end();
  });
  source.once('close', () => {
    if (!target.destroyed) {
      target.destroy();
    }
  });
  source.once('error', (error) => {
    target.destroy(error);
  });
}

export function relayWebSocket(options: WebSocketRelayOptions): void {
  const clientToUpstream = new TextFrameTransformer(options.clientToUpstreamReplacements);
  const upstreamToClient = new TextFrameTransformer(options.upstreamToClientReplacements);

  forwardFrames(
    options.clientSocket,
    options.upstreamSocket,
    clientToUpstream,
    options.clientHead,
  );
  forwardFrames(
    options.upstreamSocket,
    options.clientSocket,
    upstreamToClient,
    options.upstreamHead,
  );
}
