export type JsonRpcRequestId = number;
export type SerializedSend = (serialized: string) => void | Promise<void>;

export class JsonRpcRequestIdAllocator {
  #next = 1;
  readonly #active = new Set<number>();

  acquire(): JsonRpcRequestId {
    const start = this.#next;
    do {
      const candidate = this.#next;
      this.#next = candidate >= Number.MAX_SAFE_INTEGER ? 1 : candidate + 1;
      if (!this.#active.has(candidate)) {
        this.#active.add(candidate);
        return candidate;
      }
    } while (this.#next !== start);
    throw new Error("JSON-RPC request ID space is exhausted");
  }

  release(id: JsonRpcRequestId): void {
    if (!this.#active.delete(id)) throw new Error(`JSON-RPC request ID is not active: ${id}`);
  }

  has(id: JsonRpcRequestId): boolean {
    return this.#active.has(id);
  }
}

export class SerializedJsonWriter {
  readonly #send: SerializedSend;
  readonly #maximumMessageBytes: number;
  #tail: Promise<void> = Promise.resolve();

  constructor(send: SerializedSend, maximumMessageBytes = 4 * 1024 * 1024) {
    this.#send = send;
    this.#maximumMessageBytes = maximumMessageBytes;
  }

  write(message: unknown): Promise<void> {
    const serialized = JSON.stringify(message);
    const byteLength = Buffer.byteLength(serialized, "utf8");
    if (byteLength > this.#maximumMessageBytes) {
      return Promise.reject(
        new Error(`outbound JSON-RPC message exceeds ${this.#maximumMessageBytes} bytes`),
      );
    }
    const operation = this.#tail.then(() => this.#send(serialized));
    this.#tail = operation.catch(() => undefined);
    return operation;
  }

  async flush(): Promise<void> {
    await this.#tail;
  }
}
