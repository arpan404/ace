import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { AgentId } from "@ace/protocol";
import { createCodexAdapter } from "@ace/adapter-codex";
import type { Frame } from "@ace/engine-api";
import { withDaemonMcp } from "./services/provider-mcp.ts";
import { setup, cleanups, invoke } from "./browser-mcp-test-support.ts";

it("native provider keeps the engine's MCP lease through live configuration and revokes it on close", async () => {
  const f = await setup("codex");
  const cli = join(f.home, "fake-codex.mjs");
  await writeFile(
    cli,
    `#!${process.execPath}\nimport ${JSON.stringify(new URL("./testing/browser-mcp-cli.ts", import.meta.url).href)};\n`,
    { mode: 0o700 },
  );
  const lease = f.mcp.openSession(
    {
      sessionId: "engine-session",
      threadId: f.thread.id,
      agentId: AgentId.parse("root"),
      capabilities: ["browser", "agents", "thread_control", "automations", "projects"],
    },
    new AbortController().signal,
  );
  const connection = { url: f.mcp.url, bearer: lease.bearer, end: lease.end };
  const adapter = withDaemonMcp(
    { store: f.store, services: {}, id: () => "unused-wrapper-session" },
    createCodexAdapter({
      cli: { installed: true, path: cli, version: "0.159.1", auth: "unknown", loginHint: "fake" },
      runtime: { stopGraceMs: 0 },
    }),
  );
  const frames: Frame[] = [];
  const session = await adapter.openSession({
    threadId: f.thread.id,
    cwd: f.home,
    signal: new AbortController().signal,
    aceMcp: connection,
    env: {
      ACE_TEST_BROWSER_PROVIDER: "codex",
      ACE_TEST_BROWSER_URL: "http://localhost:3000/inherited",
    },
    onFrame: (frame) => frames.push(frame),
    onExit() {},
  });
  cleanups.push(() => session.close("shutdown"));
  expect(f.browser.state(f.thread.id)?.url).toBe("http://localhost:3000/inherited");
  if (!session.configure) throw new Error("Live configuration missing");
  await session.configure({
    provider: "codex",
    model: "switched-model",
    options: { effort: "high", serviceTier: "fast" },
  });
  await session.send([{ type: "text", text: "synthetic input" }], "queue", "configured");
  const turn = z.object({
    method: z.literal("turn/start"),
    params: z.object({ effort: z.string(), serviceTier: z.string() }),
  });
  expect(
    frames.flatMap((frame) => {
      const parsed = turn.safeParse(frame.data);
      return parsed.success ? [parsed.data.params] : [];
    }),
  ).toContainEqual({ effort: "high", serviceTier: "fast" });
  const settings = z.object({
    method: z.literal("thread/settings/update"),
    params: z.object({ model: z.string(), effort: z.string(), serviceTier: z.string() }),
  });
  expect(
    frames.flatMap((frame) => {
      const parsed = settings.safeParse(frame.data);
      return parsed.success ? [parsed.data.params] : [];
    }),
  ).toContainEqual({ model: "switched-model", effort: "high", serviceTier: "fast" });
  await session.close("shutdown");
  expect(
    (await invoke(connection, "ace_browser_open", { url: "http://localhost:3000/late" })).status,
  ).toBe(401);
});
