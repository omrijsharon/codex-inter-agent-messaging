import { describe, expect, it } from "vitest";
import { AppServerEventRouter } from "../../src/app_server/event_router.js";

describe("AppServerEventRouter", () => {
  it("routes each identifier in its own namespace", () => {
    const router = new AppServerEventRouter();
    const seen: string[] = [];
    router.subscribe({ threadId: "same" }, () => seen.push("thread"));
    router.subscribe({ turnId: "same" }, () => seen.push("turn"));
    router.subscribe({ itemId: "same" }, () => seen.push("item"));
    router.subscribe({ callId: "same" }, () => seen.push("call"));
    router.subscribe({ requestId: "same" }, () => seen.push("request"));
    router.dispatch("fixture", {
      threadId: "same",
      turnId: "turn_other",
      itemId: "item_other",
      callId: "call_other",
      requestId: "request_other",
    });
    expect(seen).toEqual(["thread"]);
  });

  it("retains a bounded sequence-addressable event history", () => {
    const router = new AppServerEventRouter(2);
    router.dispatch("one", { threadId: "thread" });
    const checkpoint = router.sequence;
    router.dispatch("two", { threadId: "thread" });
    router.dispatch("three", { threadId: "other" });
    expect(
      router.eventsSince(checkpoint, { threadId: "thread" }).map((event) => event.method),
    ).toEqual(["two"]);
    expect(router.eventsSince(0).map((event) => event.method)).toEqual(["two", "three"]);
  });
});
