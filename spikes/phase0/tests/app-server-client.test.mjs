import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { AppServerClient } from "../app-server-client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("AppServerClient correlates JSONL responses and reads notifications without blocking", async () => {
  const client = new AppServerClient({
    command: process.execPath,
    args: [path.join(here, "fake-app-server.mjs")],
    requestTimeoutMs: 5_000,
  });
  try {
    await client.connect();
    const notificationPromise = client.waitForNotification(
      (message) => message.method === "thread/status/changed",
      { timeoutMs: 5_000 },
    );
    const listed = await client.listThreads();
    const notification = await notificationPromise;
    assert.equal(listed.data[0].id, "thread_fake");
    assert.equal(notification.params.status.type, "idle");
  } finally {
    await client.close();
  }
});
