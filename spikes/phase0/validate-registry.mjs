import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AppServerClient } from "./app-server-client.mjs";

const registryUrl = new URL("./registry.json", import.meta.url);
const registry = JSON.parse(await readFile(registryUrl, "utf8"));
const expectedTitles = new Map([
  ["inter-agent", "inter-agent"],
  ["prepare-inter-agent-thread", "Prepare inter-agent thread"],
]);

assert.equal(registry.version, 1);
assert.deepEqual(Object.keys(registry.agents).sort(), [...expectedTitles.keys()].sort());

const threadIds = new Set();
for (const [agentId, agent] of Object.entries(registry.agents)) {
  assert.match(agentId, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.equal(agent.display_name, expectedTitles.get(agentId));
  assert.match(agent.thread_id, /^[0-9a-f-]{36}$/);
  assert.equal(agent.generation, 1);
  assert.equal(agent.status, "active");
  assert.equal(agent.accepts_messages, true);
  assert.equal(threadIds.has(agent.thread_id), false, `duplicate thread ID: ${agent.thread_id}`);
  threadIds.add(agent.thread_id);
}

assert.notEqual(
  registry.agents["prepare-inter-agent-thread"].display_name,
  "prepare-inter-agent-thread",
  "stable agent ID and display title must remain separate fields",
);

const client = new AppServerClient();
try {
  await client.connect();
  for (const [agentId, agent] of Object.entries(registry.agents)) {
    const response = await client.readThread(agent.thread_id, false);
    assert.equal(response.thread.id, agent.thread_id);
    assert.equal(response.thread.name, agent.display_name);
    process.stdout.write(`PASS ${agentId} -> ${agent.thread_id} (${response.thread.name})\n`);
  }
} finally {
  await client.close();
}

process.stdout.write("Validated stable Phase 0 agent mappings against app-server.\n");
