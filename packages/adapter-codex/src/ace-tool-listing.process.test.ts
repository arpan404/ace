import { expect, test } from "vitest";
import { sessionHarness } from "./session.test-helper.ts";
import { obj } from "./native.ts";
import { toolFactsDeadlineMs } from "./tool-facts.ts";

const aceMcp = { url: "http://127.0.0.1:1/mcp", bearer: "a".repeat(64) };

/** ace's server entry and guidance as the session started its Codex thread. */
async function startedWith(mode: string, runtime?: Parameters<typeof sessionHarness>[8]) {
  const h = await sessionHarness(
    false,
    mode,
    undefined,
    undefined,
    aceMcp,
    undefined,
    undefined,
    undefined,
    runtime,
  );
  try {
    const start = h.frames.find(
      (frame) => frame.dir === "send" && obj(frame.data).method === "thread/start",
    );
    const params = obj(obj(start?.data).params);
    const ace = obj(obj(params.config)["mcp_servers.ace"]);
    return {
      headers: obj(ace.http_headers),
      prompted: Object.keys(obj(ace.tools)),
      instructions: String(params.developerInstructions),
    };
  } finally {
    await h.dispose();
  }
}

test("a Codex thread on its catalog's default model lists every ace tool for Codex to defer", async () => {
  const { headers, prompted, instructions } = await startedWith("");
  expect(headers["X-Ace-Tools"]).toBeUndefined();
  expect(prompted).not.toContain("tools_call");
  expect(prompted).toContain("automation_remove");
  expect(instructions).toContain("await tools.mcp__ace__<name>(args)");
  expect(instructions).toContain("tool_search");
  expect(instructions).not.toContain("Your ace list is fixed");
});

test("a configured model found on a later page of Codex's catalog keeps every ace tool listed", async () => {
  const { headers } = await startedWith("late-catalog-model");
  expect(headers["X-Ace-Tools"]).toBeUndefined();
});

test("a Codex thread on a model outside its catalog gets the fixed list, and only the destructive tool keeps Codex's prompt", async () => {
  const { headers, prompted, instructions } = await startedWith("oss-model");
  // Codex would load every listed tool upfront for this model and never reload.
  expect(headers["X-Ace-Tools"]).toBe("static");
  // automation_remove is listed by name there and tools_call refuses it, so tools_call runs
  // without an ask even where Codex never asks (read-only access).
  expect(prompted).toContain("automation_remove");
  expect(prompted).not.toContain("tools_call");
  expect(instructions).toContain("tools_call {name, arguments}");
});

/** The real clock, for a deadline that has to pass while the app-server never answers. */
function schedule(callback: () => void, delayMs: number) {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
}

test("a stalled app-server delays a Codex thread start only by the discovery deadline, then lists every tool", async () => {
  const started = performance.now();
  const { headers } = await startedWith("stalled-facts", { schedule });
  expect(performance.now() - started).toBeLessThan(toolFactsDeadlineMs + 2_000);
  expect(headers["X-Ace-Tools"]).toBeUndefined();
});
