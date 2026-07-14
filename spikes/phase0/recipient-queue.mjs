import { setTimeout as delay } from "node:timers/promises";

export function isBusyAppServerError(error) {
  const details = [error?.code, error?.message, JSON.stringify(error?.data ?? null)]
    .filter(Boolean)
    .join(" ");
  return /recipient_busy|\bbusy\b|active turn|thread[^\n]*active|turn[^\n]*(in progress|already running)/i.test(details);
}

export async function startWhenRecipientIdle(
  client,
  threadId,
  start,
  { pollMs = 100, maxWaitMs = 120_000, now = Date.now, sleep = delay } = {},
) {
  const queuedAt = now();
  const deadline = queuedAt + maxWaitMs;
  let observedBusy = false;
  let checks = 0;

  while (true) {
    checks += 1;
    const resumed = await client.resumeThread(threadId);
    const status = resumed?.thread?.status?.type ?? "unknown";

    if (status === "idle" || status === "unknown") {
      const dispatchAt = now();
      try {
        const result = await start();
        return {
          result,
          queuedMs: Math.max(0, dispatchAt - queuedAt),
          observedBusy,
          checks,
        };
      } catch (error) {
        if (!isBusyAppServerError(error)) throw error;
        observedBusy = true;
      }
    } else {
      observedBusy = true;
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      const error = new Error(`recipient thread remained busy for ${maxWaitMs}ms`);
      error.code = "RECIPIENT_BUSY_TIMEOUT";
      throw error;
    }
    await sleep(Math.min(pollMs, remainingMs));
  }
}
