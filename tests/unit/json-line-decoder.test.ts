import { describe, expect, it } from "vitest";
import { JsonLineDecoder, ProtocolFrameError } from "../../src/app_server/json_line_decoder.js";

describe("JsonLineDecoder", () => {
  it("buffers partial reads and emits multiple CRLF or LF frames", () => {
    const decoder = new JsonLineDecoder();
    expect(decoder.push('{"id":1')).toEqual([]);
    expect(decoder.push(',"result":{}}\r\n{"method":"ready"}\n')).toEqual([
      { id: 1, result: {} },
      { method: "ready" },
    ]);
    decoder.finish();
  });

  it("reports malformed JSON without including its content", () => {
    const decoder = new JsonLineDecoder();
    expect(() => decoder.push('{"token":"secret"\n')).toThrowError(
      expect.objectContaining({
        code: "MALFORMED_JSON",
        message: "received malformed JSON-RPC frame",
      }),
    );
  });

  it("enforces the maximum on complete and buffered frames", () => {
    const complete = new JsonLineDecoder(4);
    expect(() => complete.push("12345\n")).toThrowError(
      expect.objectContaining({ code: "FRAME_TOO_LARGE", byteLength: 5 }),
    );
    const buffered = new JsonLineDecoder(4);
    expect(() => buffered.push("12345")).toThrowError(
      expect.objectContaining({ code: "FRAME_TOO_LARGE", byteLength: 5 }),
    );
  });

  it("reports a truncated final frame and clears it", () => {
    const decoder = new JsonLineDecoder();
    decoder.push('{"id":1}');
    expect(() => decoder.finish()).toThrowError(ProtocolFrameError);
    expect(() => decoder.finish()).not.toThrow();
  });
});
