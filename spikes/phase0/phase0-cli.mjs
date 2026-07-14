import { AppServerClient } from "./app-server-client.mjs";

function parseJsonArgument(value) {
  if (!value) return {};
  const json = value.startsWith("base64:")
    ? Buffer.from(value.slice("base64:".length), "base64").toString("utf8")
    : value;
  return JSON.parse(json);
}

const [command = "list", ...args] = process.argv.slice(2);
const client = new AppServerClient();
client.on("stderr", (chunk) => process.stderr.write(chunk));

try {
  await client.connect();
  let result;
  if (command === "list") {
    result = await client.listThreads({ searchTerm: args.join(" ") || undefined });
  } else if (command === "search") {
    if (!args[0]) throw new Error("usage: phase0-cli.mjs search <query>");
    result = await client.searchThreads(args.join(" "));
  } else if (command === "read") {
    if (!args[0]) throw new Error("usage: phase0-cli.mjs read <thread-id>");
    result = await client.readThread(args[0], false);
  } else if (command === "read-full") {
    if (!args[0]) throw new Error("usage: phase0-cli.mjs read-full <thread-id>");
    result = await client.readThread(args[0], true);
  } else if (command === "summary") {
    if (!args[0]) throw new Error("usage: phase0-cli.mjs summary <thread-id>");
    result = await client.getConversationSummary(args[0]);
  } else if (command === "resume") {
    if (!args[0]) throw new Error("usage: phase0-cli.mjs resume <thread-id>");
    result = await client.resumeThread(args[0]);
  } else if (command === "compact") {
    if (!args[0]) throw new Error("usage: phase0-cli.mjs compact <thread-id>");
    await client.resumeThread(args[0]);
    result = await client.compactThread(args[0]);
  } else if (command === "mcp-status") {
    if (!args[0]) throw new Error("usage: phase0-cli.mjs mcp-status <thread-id>");
    await client.resumeThread(args[0]);
    result = await client.listMcpServerStatus(args[0]);
  } else if (command === "mcp-call") {
    if (!args[0] || !args[1] || !args[2]) {
      throw new Error("usage: phase0-cli.mjs mcp-call <thread-id> <server> <tool> [json-arguments]");
    }
    await client.resumeThread(args[0]);
    result = await client.callMcpTool(args[0], args[1], args[2], parseJsonArgument(args[3]));
  } else if (command === "turn") {
    if (!args[0] || !args[1]) throw new Error("usage: phase0-cli.mjs turn <thread-id> <message>");
    result = await client.startTurnAndCollect(args[0], args.slice(1).join(" "));
  } else {
    throw new Error(`unknown command: ${command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await client.close();
}
