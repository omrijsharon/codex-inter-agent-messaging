import { isJsonObject, type JsonObject } from "./protocol.js";
import type { AppServerEvent, AppServerEventRouter } from "./event_router.js";

export interface CollectedTurn {
  readonly threadId: string;
  readonly turnId: string;
  readonly status: string;
  readonly turn: JsonObject;
  readonly agentMessages: readonly JsonObject[];
  readonly finalMessage: JsonObject | null;
}

export class TurnCollectionError extends Error {
  readonly code: "TURN_TIMEOUT" | "TURN_CANCELLED";
  constructor(code: "TURN_TIMEOUT" | "TURN_CANCELLED", message: string) {
    super(message);
    this.name = "TurnCollectionError";
    this.code = code;
  }
}

export class TurnOutcomeError extends Error {
  readonly code: "TURN_NOT_COMPLETED" | "MISSING_FINAL_REPLY";
  constructor(code: "TURN_NOT_COMPLETED" | "MISSING_FINAL_REPLY", message: string) {
    super(message);
    this.name = "TurnOutcomeError";
    this.code = code;
  }
}

export function extractAuthoritativeFinalReply(collected: CollectedTurn): string {
  if (collected.status !== "completed") {
    throw new TurnOutcomeError(
      "TURN_NOT_COMPLETED",
      `recipient turn ended with status ${collected.status}`,
    );
  }
  const text = collected.finalMessage?.text;
  if (typeof text !== "string" || text.length === 0) {
    throw new TurnOutcomeError(
      "MISSING_FINAL_REPLY",
      "completed recipient turn has no agent reply",
    );
  }
  return text;
}

export function collectTurn(
  router: AppServerEventRouter,
  threadId: string,
  turnId: string,
  afterSequence: number,
  { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal },
): Promise<CollectedTurn> {
  return new Promise((resolve, reject) => {
    const messages: JsonObject[] = [];
    let terminal: JsonObject | null = null;
    let finalizeTimer: NodeJS.Timeout | null = null;
    const timer = setTimeout(() => {
      cleanup();
      reject(new TurnCollectionError("TURN_TIMEOUT", `timed out waiting for turn ${turnId}`));
    }, timeoutMs);
    const onAbort = (): void => {
      cleanup();
      reject(new TurnCollectionError("TURN_CANCELLED", `cancelled waiting for turn ${turnId}`));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (): void => {
      if (!terminal) return;
      const status = typeof terminal.status === "string" ? terminal.status : "unknown";
      const finalMessage =
        [...messages].reverse().find((item) => item.phase === "final_answer") ??
        messages.at(-1) ??
        null;
      cleanup();
      resolve({ threadId, turnId, status, turn: terminal, agentMessages: messages, finalMessage });
    };
    const scheduleFinish = (): void => {
      if (finalizeTimer) return;
      finalizeTimer = setTimeout(finish, 0);
    };
    const accept = (event: AppServerEvent): void => {
      if (event.method === "item/completed" && isJsonObject(event.params.item)) {
        if (event.params.item.type === "agentMessage") messages.push(event.params.item);
        if (terminal) scheduleFinish();
      }
      if (event.method === "turn/completed" && isJsonObject(event.params.turn)) {
        terminal = event.params.turn;
        scheduleFinish();
      }
    };
    const unsubscribe = router.subscribe({ threadId, turnId }, accept);
    const cleanup = (): void => {
      clearTimeout(timer);
      if (finalizeTimer) clearTimeout(finalizeTimer);
      signal?.removeEventListener("abort", onAbort);
      unsubscribe();
    };
    for (const event of router.eventsSince(afterSequence, { threadId, turnId })) accept(event);
  });
}
