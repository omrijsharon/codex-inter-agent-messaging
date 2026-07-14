import readline from "node:readline";

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    write({ id: message.id, result: { serverInfo: { name: "fake-app-server" } } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/list") {
    write({
      method: "thread/status/changed",
      params: { threadId: "thread_fake", status: { type: "idle" } },
    });
    write({ id: message.id, result: { data: [{ id: "thread_fake" }], nextCursor: null } });
    return;
  }
  write({ id: message.id, error: { code: -32601, message: `unsupported method ${message.method}` } });
});
