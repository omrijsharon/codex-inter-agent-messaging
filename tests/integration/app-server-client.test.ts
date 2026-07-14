import { once } from "node:events";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { AppServerClient, AppServerRequestError } from "../../src/app_server/client.js";
import { extractAuthoritativeFinalReply } from "../../src/app_server/turn_collector.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function fixtureServer(port = 0) {
  const server = new WebSocketServer({ host: "127.0.0.1", port });
  await once(server, "listening");
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("fixture server has no address");
  let socket: WebSocket | null = null;
  const received: Array<Record<string, unknown>> = [];
  server.on("connection", (connected) => {
    socket = connected;
    connected.on("message", (data) => {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Buffer.from(new Uint8Array(data)).toString("utf8");
      const message = JSON.parse(text) as Record<string, unknown>;
      received.push(message);
      const id = message.id;
      const method = message.method;
      if (method === "initialize") {
        connected.send(
          JSON.stringify({
            id,
            result: {
              userAgent: "fixture",
              codexHome: "C:/fixture",
              platformFamily: "windows",
              platformOs: "windows",
            },
          }),
        );
      } else if (method === "echo") {
        const params = message.params as Record<string, unknown>;
        const wait = Number(params.wait ?? 0);
        setTimeout(() => connected.send(JSON.stringify({ id, result: params.value })), wait);
      } else if (method === "thread/list") {
        connected.send(JSON.stringify({ id, result: { data: [{ id: "thread_fixture" }] } }));
      } else if (method === "thread/read" || method === "thread/resume") {
        connected.send(
          JSON.stringify({
            id,
            result: { thread: { id: "thread_fixture", status: { type: "idle" } } },
          }),
        );
      } else if (method === "thread/compact/start") {
        connected.send(JSON.stringify({ id, result: {} }));
      } else if (method === "server-error") {
        connected.send(
          JSON.stringify({
            id,
            error: { code: -32600, message: "fixture failure", data: { safe: true } },
          }),
        );
      } else if (method === "disconnect") {
        connected.close();
      } else if (method === "turn/start") {
        const params = message.params as Record<string, unknown>;
        const clientId = params.clientUserMessageId;
        connected.send(JSON.stringify({ id, result: { turn: { id: "turn_fixture" } } }));
        if (clientId === "msg_interrupted" || clientId === "msg_failed") {
          connected.send(
            JSON.stringify({
              method: "turn/completed",
              params: {
                threadId: "thread_fixture",
                turn: {
                  id: "turn_fixture",
                  status: clientId === "msg_interrupted" ? "interrupted" : "failed",
                },
              },
            }),
          );
          return;
        }
        connected.send(
          JSON.stringify({
            method: "item/completed",
            params: {
              threadId: "other_thread",
              turnId: "turn_fixture",
              item: { id: "noise", type: "agentMessage", text: "NOISE", phase: "final_answer" },
            },
          }),
        );
        connected.send(
          JSON.stringify({
            method: "turn/completed",
            params: {
              threadId: "thread_fixture",
              turn: { id: "turn_fixture", status: "completed" },
            },
          }),
        );
        connected.send(
          JSON.stringify({
            method: "item/completed",
            params: {
              threadId: "thread_fixture",
              turnId: "turn_fixture",
              item: { id: "final", type: "agentMessage", text: "FINAL", phase: "final_answer" },
            },
          }),
        );
      }
    });
  });
  return {
    url: `ws://127.0.0.1:${address.port}`,
    received,
    send(message: unknown) {
      if (!socket) throw new Error("fixture socket is not connected");
      socket.send(JSON.stringify(message));
    },
    sendRaw(message: string) {
      if (!socket) throw new Error("fixture socket is not connected");
      socket.send(message);
    },
  };
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof address !== "object" || !address) throw new Error("could not reserve port");
  return address.port;
}

describe("AppServerClient", () => {
  it("negotiates, correlates out-of-order responses, routes events, and collects a turn", async () => {
    const fixture = await fixtureServer();
    const client = new AppServerClient({
      url: fixture.url,
      authToken: "fixture",
      reconnectLimit: 0,
    });
    cleanup.push(() => client.close());
    await client.connect();
    expect(client.ready).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fixture.received.some((message) => message.method === "initialized")).toBe(true);

    const [first, second] = await Promise.all([
      client.request("echo", { value: "first", wait: 20 }),
      client.request("echo", { value: "second", wait: 0 }),
    ]);
    expect([first, second]).toEqual(["first", "second"]);
    expect(await client.listThreads()).toHaveProperty("data");
    expect(await client.readThread("thread_fixture")).toHaveProperty("thread.id", "thread_fixture");
    expect(await client.resumeThread("thread_fixture")).toHaveProperty(
      "thread.status.type",
      "idle",
    );
    await expect(client.compactThread("thread_fixture")).resolves.toEqual({});

    const started = await client.startTurn("thread_fixture", "hello", {
      clientUserMessageId: "msg_1",
    });
    expect(started.turnId).toBe("turn_fixture");
    const completed = await started.completion;
    expect(completed.status).toBe("completed");
    expect(completed.finalMessage).toMatchObject({ text: "FINAL", phase: "final_answer" });
    expect(completed.agentMessages).toHaveLength(1);
    expect(extractAuthoritativeFinalReply(completed)).toBe("FINAL");

    const interrupted = await client.startTurn("thread_fixture", "stop", {
      clientUserMessageId: "msg_interrupted",
    });
    const interruptedResult = await interrupted.completion;
    expect(interruptedResult).toMatchObject({
      status: "interrupted",
      finalMessage: null,
    });
    expect(() => extractAuthoritativeFinalReply(interruptedResult)).toThrowError(
      expect.objectContaining({ code: "TURN_NOT_COMPLETED" }),
    );
    const failed = await client.startTurn("thread_fixture", "fail", {
      clientUserMessageId: "msg_failed",
    });
    await expect(failed.completion).resolves.toMatchObject({
      status: "failed",
      finalMessage: null,
    });
  });

  it("handles server requests asynchronously while reader correlation continues", async () => {
    const fixture = await fixtureServer();
    const handled: string[] = [];
    const client = new AppServerClient({
      url: fixture.url,
      authToken: "fixture",
      reconnectLimit: 0,
      serverRequestHandler: async (method) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        handled.push(method);
        return { decision: "decline" };
      },
    });
    cleanup.push(() => client.close());
    await client.connect();
    fixture.send({ id: 900, method: "item/tool/call", params: { callId: "call_1" } });
    fixture.send({
      id: 901,
      method: "item/commandExecution/requestApproval",
      params: { callId: "approval_1" },
    });
    await expect(client.request("echo", { value: "reader-live" })).resolves.toBe("reader-live");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handled).toEqual(["item/tool/call", "item/commandExecution/requestApproval"]);
    expect(fixture.received).toContainEqual({ id: 900, result: { decision: "decline" } });
    expect(fixture.received).toContainEqual({ id: 901, result: { decision: "decline" } });
  });

  it("declines unattended approval and elicitation requests by default", async () => {
    const fixture = await fixtureServer();
    const client = new AppServerClient({
      url: fixture.url,
      authToken: "fixture",
      reconnectLimit: 0,
    });
    cleanup.push(() => client.close());
    await client.connect();
    fixture.send({ id: 910, method: "item/commandExecution/requestApproval", params: {} });
    fixture.send({ id: 911, method: "item/fileChange/requestApproval", params: {} });
    fixture.send({ id: 912, method: "mcpServer/elicitation/request", params: {} });
    fixture.send({ id: 913, method: "item/permissions/requestApproval", params: {} });
    await expect(client.request("echo", { value: "still-responsive" })).resolves.toBe(
      "still-responsive",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fixture.received).toContainEqual({ id: 910, result: { decision: "decline" } });
    expect(fixture.received).toContainEqual({ id: 911, result: { decision: "decline" } });
    expect(fixture.received).toContainEqual({
      id: 912,
      result: { action: "decline", content: null, _meta: null },
    });
    expect(fixture.received).toContainEqual({
      id: 913,
      error: {
        code: -32601,
        message: "unattended server request denied: item/permissions/requestApproval",
      },
    });
  });

  it("maps timeout, cancellation, malformed input, and disconnect", async () => {
    const fixture = await fixtureServer();
    const client = new AppServerClient({
      url: fixture.url,
      authToken: "fixture",
      reconnectLimit: 0,
    });
    cleanup.push(() => client.close());
    await client.connect();
    await expect(client.request("never", {}, { timeoutMs: 10 })).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
    });
    const abort = new AbortController();
    const cancelled = client.request("never", {}, { signal: abort.signal });
    abort.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    await expect(client.request("server-error")).rejects.toMatchObject({
      code: -32600,
      message: "fixture failure",
      data: { safe: true },
    });
    const protocolError = new Promise<Error>((resolve) =>
      client.once("protocolError", (error: Error) => resolve(error)),
    );
    fixture.sendRaw("not-json");
    const error = await protocolError;
    expect(error).toBeInstanceOf(AppServerRequestError);
    await expect(client.request("disconnect")).rejects.toMatchObject({ code: "TRANSPORT_CLOSED" });
    await client.close();
    await expect(client.request("echo")).rejects.toMatchObject({ code: "NOT_CONNECTED" });
  });

  it("retries initial connection according to the bounded reconnect policy", async () => {
    const port = await reservePort();
    const client = new AppServerClient({
      url: `ws://127.0.0.1:${port}`,
      authToken: "fixture",
      reconnectLimit: 3,
    });
    cleanup.push(() => client.close());
    const connecting = client.connect();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await fixtureServer(port);
    await expect(connecting).resolves.toBeUndefined();
    expect(client.ready).toBe(true);
  });
});
