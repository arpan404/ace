import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { Frame } from "@ace/engine-api";
import { harness, subtype } from "./session.test-helper.ts";
import { object } from "./native.ts";

const aceMcp = { url: "http://127.0.0.1:9012/mcp", bearer: "b".repeat(64) };
/** Nothing from the test runner's own environment decides tool search here. */
const neutral = {
  ENABLE_TOOL_SEARCH: "",
  ANTHROPIC_BASE_URL: "",
  ANTHROPIC_MODEL: "",
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "",
  CLAUDE_CODE_USE_BEDROCK: "",
  CLAUDE_CODE_USE_VERTEX: "",
  CLAUDE_CODE_USE_FOUNDRY: "",
  CLAUDE_CODE_USE_GATEWAY: "",
};
let config: string;
beforeEach(async () => {
  config = await mkdtemp(join(tmpdir(), "ace-claude-config-"));
});
afterEach(async () => {
  await rm(config, { recursive: true, force: true });
});

async function open(env: Record<string, string> = {}) {
  return harness(
    undefined,
    "root",
    { env: { ...neutral, CLAUDE_CONFIG_DIR: config, ...env } },
    { aceMcp },
  );
}
const isInitialize = (f: Frame) =>
  subtype("fake_control")(f) && object(object(f.data)["request"])["subtype"] === "initialize";
const isSetServers = (f: Frame) =>
  subtype("fake_control")(f) && object(object(f.data)["request"])["subtype"] === "mcp_set_servers";
function aceHeaders(servers: unknown): Record<string, unknown> {
  return object(object(object(servers)["ace"])["headers"]);
}

test("a Claude session launched with tool search off connects ace with the core listing", async () => {
  const h = await open({ ENABLE_TOOL_SEARCH: "false" });
  try {
    const control = object((await h.wait(isInitialize)).data);
    expect(aceHeaders(control["mcpServers"])["X-Ace-Tools"]).toBe("core");
    // The guidance says how to reach tools the small list does not hold yet.
    expect(String(object(control["request"])["appendSystemPrompt"])).toContain("tools_call");
  } finally {
    await h.session.close("shutdown");
  }
});

test("tool search turned off in the person's Claude settings gives the core listing", async () => {
  await writeFile(
    join(config, "settings.json"),
    JSON.stringify({ env: { ENABLE_TOOL_SEARCH: "false" } }),
  );
  const h = await open();
  try {
    const control = object((await h.wait(isInitialize)).data);
    expect(aceHeaders(control["mcpServers"])["X-Ace-Tools"]).toBe("core");
  } finally {
    await h.session.close("shutdown");
  }
});

test("a Claude session with tool search on lists every ace tool for it to defer", async () => {
  const h = await open();
  try {
    const control = object((await h.wait(isInitialize)).data);
    expect(aceHeaders(control["mcpServers"])).not.toHaveProperty("X-Ace-Tools");
    expect(String(object(control["request"])["appendSystemPrompt"])).toContain("select:mcp__ace__");
  } finally {
    await h.session.close("shutdown");
  }
});

test("switching to a model without tool search reconnects ace with the core listing, and a later server change keeps it", async () => {
  const h = await open();
  try {
    await h.wait(isInitialize);
    await h.session.configure?.({
      provider: "claude",
      model: "claude-3-5-haiku-20241022",
      options: {},
    });
    const reconnect = object((await h.wait(isSetServers)).data);
    expect(aceHeaders(object(reconnect["request"])["servers"])["X-Ace-Tools"]).toBe("core");
    // A caller replacing the MCP set with its own copy of ace's server does not widen the list.
    await h.session.mcp?.replace({ ace: { type: "http", url: aceMcp.url } });
    const replaced = h.frames.filter(isSetServers).at(-1);
    expect(aceHeaders(object(object(replaced?.data)["request"])["servers"])["X-Ace-Tools"]).toBe(
      "core",
    );
  } finally {
    await h.session.close("shutdown");
  }
});
