import { describe, expect, it } from "vitest";
import { createLogger, LOG_EVENTS, redactLogFields } from "../../src/logging/logger.js";

describe("structured logger", () => {
  it("emits stable JSON events with correlation fields", () => {
    const lines: string[] = [];
    const logger = createLogger(
      "debug",
      (line) => lines.push(line),
      () => new Date("2026-07-14T12:00:00.000Z"),
    );
    logger.info(LOG_EVENTS.messageQueued, { messageId: "msg_1", recipientAgentId: "cfo" });
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      timestamp: "2026-07-14T12:00:00.000Z",
      level: "info",
      event: "message.queued",
      messageId: "msg_1",
      recipientAgentId: "cfo",
    });
  });

  it("redacts secrets, peer text, and sensitive paths recursively", () => {
    expect(
      redactLogFields({
        token: "capability",
        messageBody: "private request",
        nested: { authorization: "Bearer abc", databasePath: "C:/Users/name/db" },
        detail: "request failed with Bearer abc.def.ghi",
        messageId: "msg_safe",
      }),
    ).toEqual({
      token: "[REDACTED]",
      messageBody: "[REDACTED]",
      nested: { authorization: "[REDACTED]", databasePath: "[REDACTED]" },
      detail: "[REDACTED]",
      messageId: "msg_safe",
    });
  });

  it("honors the configured minimum level", () => {
    const lines: string[] = [];
    const logger = createLogger("warn", (line) => lines.push(line));
    logger.info(LOG_EVENTS.bridgeReady);
    logger.warn(LOG_EVENTS.appServerDisconnected);
    expect(lines).toHaveLength(1);
  });
});
