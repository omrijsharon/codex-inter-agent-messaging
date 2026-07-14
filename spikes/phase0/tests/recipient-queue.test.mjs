import assert from "node:assert/strict";
import test from "node:test";
import { startWhenRecipientIdle } from "../recipient-queue.mjs";

test("busy recipient waits and dispatches once after becoming idle", async () => {
  const statuses = ["active", "active", "idle"];
  let clock = 0;
  let starts = 0;
  const client = {
    async resumeThread() {
      return { thread: { status: { type: statuses.shift() ?? "idle" } } };
    },
  };

  const outcome = await startWhenRecipientIdle(
    client,
    "thread_target",
    async () => {
      starts += 1;
      return { turnId: "turn_once" };
    },
    {
      pollMs: 25,
      maxWaitMs: 1_000,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    },
  );

  assert.equal(starts, 1);
  assert.equal(outcome.result.turnId, "turn_once");
  assert.equal(outcome.observedBusy, true);
  assert.equal(outcome.queuedMs, 50);
  assert.equal(outcome.checks, 3);
});

test("turn-start busy race returns to the queue", async () => {
  let starts = 0;
  let clock = 0;
  const client = {
    async resumeThread() {
      return { thread: { status: { type: "idle" } } };
    },
  };

  const outcome = await startWhenRecipientIdle(
    client,
    "thread_target",
    async () => {
      starts += 1;
      if (starts === 1) {
        const error = new Error("thread already has an active turn");
        error.code = -32600;
        throw error;
      }
      return { turnId: "turn_after_race" };
    },
    {
      pollMs: 10,
      maxWaitMs: 1_000,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    },
  );

  assert.equal(starts, 2);
  assert.equal(outcome.observedBusy, true);
  assert.equal(outcome.queuedMs, 10);
});

test("busy recipient fails with a bounded typed timeout", async () => {
  let clock = 0;
  const client = {
    async resumeThread() {
      return { thread: { status: { type: "active" } } };
    },
  };

  await assert.rejects(
    startWhenRecipientIdle(client, "thread_target", async () => assert.fail("must not dispatch"), {
      pollMs: 20,
      maxWaitMs: 50,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    }),
    (error) => error.code === "RECIPIENT_BUSY_TIMEOUT",
  );
});
