export type ProtocolFrameErrorCode = "FRAME_TOO_LARGE" | "MALFORMED_JSON" | "TRUNCATED_FRAME";

export class ProtocolFrameError extends Error {
  readonly code: ProtocolFrameErrorCode;
  readonly byteLength: number;

  constructor(code: ProtocolFrameErrorCode, message: string, byteLength: number) {
    super(message);
    this.name = "ProtocolFrameError";
    this.code = code;
    this.byteLength = byteLength;
  }
}

export class JsonLineDecoder {
  readonly #maximumFrameBytes: number;
  #buffer = Buffer.alloc(0);

  constructor(maximumFrameBytes = 4 * 1024 * 1024) {
    if (!Number.isSafeInteger(maximumFrameBytes) || maximumFrameBytes < 1) {
      throw new Error("maximumFrameBytes must be a positive safe integer");
    }
    this.#maximumFrameBytes = maximumFrameBytes;
  }

  push(chunk: Uint8Array | string): unknown[] {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    this.#buffer = Buffer.concat([this.#buffer, bytes]);
    const messages: unknown[] = [];

    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) break;
      const rawLine = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      const line = rawLine.at(-1) === 0x0d ? rawLine.subarray(0, -1) : rawLine;
      if (line.length === 0) continue;
      messages.push(this.#parse(line));
    }

    if (this.#buffer.length > this.#maximumFrameBytes) {
      const byteLength = this.#buffer.length;
      this.#buffer = Buffer.alloc(0);
      throw new ProtocolFrameError(
        "FRAME_TOO_LARGE",
        `JSON-RPC frame exceeds ${this.#maximumFrameBytes} bytes`,
        byteLength,
      );
    }
    return messages;
  }

  finish(): void {
    if (this.#buffer.length === 0) return;
    const byteLength = this.#buffer.length;
    this.#buffer = Buffer.alloc(0);
    throw new ProtocolFrameError(
      "TRUNCATED_FRAME",
      "transport ended with a partial JSON frame",
      byteLength,
    );
  }

  #parse(line: Buffer): unknown {
    if (line.length > this.#maximumFrameBytes) {
      throw new ProtocolFrameError(
        "FRAME_TOO_LARGE",
        `JSON-RPC frame exceeds ${this.#maximumFrameBytes} bytes`,
        line.length,
      );
    }
    try {
      return JSON.parse(line.toString("utf8")) as unknown;
    } catch {
      throw new ProtocolFrameError(
        "MALFORMED_JSON",
        "received malformed JSON-RPC frame",
        line.length,
      );
    }
  }
}
