import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderKind } from "@ace/protocol";
import { aceInstructions, developerInstructions } from "@ace/mcp-server";
import { afterEach, expect, it } from "vitest";
import { computerUseTools } from "@ace/screen";
import { readConfig, startDaemon } from "./index.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

/** Tool names as guidance writes them: ace_x, screen_x, device_x and delegate_task. */
function namedTools(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/\b(?:ace|screen|device)_[a-z0-9_]+\b|\bdelegate_task\b/g)].map(
        ([name]) => name,
      ),
    ),
  ].filter((name) => !name.endsWith("_"));
}

it("ace's guidance names only tools the daemon registers", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-guidance-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
  });
  cleanup.push(() => daemon.close());
  if (!daemon.mcp) throw new Error("Missing MCP server");
  // Computer use registers only with a screen manager; its catalogue is fixed.
  const registered = new Set([
    ...daemon.mcp.toolNames(),
    ...computerUseTools.map((tool) => tool.name),
  ]);
  const texts = [aceInstructions, ...ProviderKind.options.map((p) => developerInstructions(p))];
  const named = new Set(texts.flatMap(namedTools));
  // OpenCode's own prefix example is not an ace tool name.
  named.delete("ace_ace_status");
  named.delete("ace_delegate_task");
  expect(named.size).toBeGreaterThan(10);
  // Simulator tools (device_*) register only when the devices service runs.
  const missing = [...named].filter((name) => !registered.has(name) && !name.startsWith("device_"));
  expect(missing).toEqual([]);
});
