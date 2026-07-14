import { AppServerClient } from "./app-server-client.mjs";

const targetThreadId = process.argv[2];
if (!targetThreadId) throw new Error("usage: recovery-probe.mjs <target-thread-id>");

const preservedSummary = `
This is a history-preserving recovery probe for the existing Update ESP32S3-CAM webapp thread.
The project is an ESP32-S3 Sense PlatformIO baby-monitor webapp for local Wi-Fi video and audio.
The latest work was diagnosing an ESP32 crash loop and audio initialization. Audio initialization
was moved away from unconditional startup; the next work was to make lazy audio allocation safe,
rebuild, flash, and capture a serial backtrace. COM19 was locked by stale pio/python processes.
This probe must not modify repository files or hardware. Reply only with RECOVERY_PROBE_OK.
`.trim();

const client = new AppServerClient({ requestTimeoutMs: 180_000 });
client.on("stderr", (chunk) => process.stderr.write(chunk));

try {
  await client.connect();
  const helper = await client.startThread({
    ephemeral: true,
    experimentalRawEvents: true,
    model: "gpt-5.6-terra",
    cwd: "C:\\Users\\tamipinhasi\\Documents\\PlatformIO\\Projects\\ESP32-CAM_MJPEG2SD",
    approvalPolicy: "never",
    sandbox: "read-only",
    config: { model_reasoning_effort: "medium" },
  });
  const helperThreadId = helper?.thread?.id;
  if (!helperThreadId) throw new Error("thread/start response did not include helper thread.id");
  const helperTurn = await client.startTurnAndCollect(
    helperThreadId,
    `${preservedSummary}\n\nAcknowledge this recovery summary by replying exactly SUMMARY_READY.`,
    { model: "gpt-5.6-terra", effort: "medium", timeoutMs: 180_000 },
  );
  if (helperTurn.turn?.status !== "completed") {
    throw new Error(`helper summary turn failed: ${JSON.stringify(helperTurn.turn?.error)}`);
  }
  const captured = await client.compactThreadAndCaptureRaw(helperThreadId, { timeoutMs: 180_000 });

  const forked = await client.forkThread(targetThreadId, {
    ephemeral: true,
    model: "gpt-5.6-terra",
    cwd: "C:\\Users\\tamipinhasi\\Documents\\PlatformIO\\Projects\\ESP32-CAM_MJPEG2SD",
    approvalPolicy: "never",
    sandbox: "read-only",
    config: {
      model_reasoning_effort: "medium",
    },
  });
  const forkThreadId = forked?.thread?.id;
  if (!forkThreadId) throw new Error("thread/fork response did not include thread.id");

  await client.injectItems(forkThreadId, [
    captured.item,
  ]);

  const result = await client.startTurnAndCollect(
    forkThreadId,
    "Reply exactly RECOVERY_PROBE_OK. Do not call tools.",
    { model: "gpt-5.6-terra", effort: "medium", timeoutMs: 180_000 },
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        helperThreadId,
        capturedCompaction: {
          type: captured.item.type,
          encryptedContentLength: captured.item.encrypted_content?.length ?? 0,
        },
        forkThreadId,
        result,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await client.close();
}
