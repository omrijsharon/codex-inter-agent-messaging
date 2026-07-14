import { describe, expect, it } from "vitest";
import {
  JsonRpcRequestIdAllocator,
  SerializedJsonWriter,
} from "../../src/app_server/json_rpc_writer.js";

describe("JsonRpcRequestIdAllocator", () => {
  it("allocates collision-free active IDs and validates release", () => {
    const ids = new JsonRpcRequestIdAllocator();
    const first = ids.acquire();
    const second = ids.acquire();
    expect(first).not.toBe(second);
    expect(ids.has(first)).toBe(true);
    ids.release(first);
    expect(ids.has(first)).toBe(false);
    expect(() => ids.release(first)).toThrow(/not active/);
  });
});

describe("SerializedJsonWriter", () => {
  it("preserves invocation order across asynchronous sends", async () => {
    const sent: number[] = [];
    const writer = new SerializedJsonWriter(async (serialized) => {
      const message = JSON.parse(serialized) as { id: number };
      await new Promise((resolve) => setTimeout(resolve, message.id === 1 ? 20 : 0));
      sent.push(message.id);
    });
    await Promise.all([writer.write({ id: 1 }), writer.write({ id: 2 }), writer.write({ id: 3 })]);
    expect(sent).toEqual([1, 2, 3]);
  });

  it("continues after a failed send and bounds outbound messages", async () => {
    let calls = 0;
    const writer = new SerializedJsonWriter(() => {
      calls += 1;
      if (calls === 1) throw new Error("send failed");
    }, 16);
    await expect(writer.write({ id: 1 })).rejects.toThrow("send failed");
    await expect(writer.write({ id: 2 })).resolves.toBeUndefined();
    await expect(writer.write({ payload: "this is too long" })).rejects.toThrow(/exceeds/);
    await writer.flush();
  });
});
