import { ThreadId } from "@ace/protocol";
import { it, expect } from "vitest";
import { antigravityAdapter, createAcpAdapter } from "./index.ts";
it("limits Antigravity controls to known server versions", () => {
  const cli = { installed: true, auth: "unknown" as const, loginHint: "server configuration" };
  expect(antigravityAdapter.capabilities(cli).resume).toBe(false);
  expect(antigravityAdapter.capabilities({ ...cli, version: "1.2.1" })).toMatchObject({
    resume: true,
    subagentTranscripts: false,
    backgroundTaskControl: false,
  });
});
it("requires generic ACP to name an installed executable instead of bundling one", async () => {
  const ctx = {
    threadId: ThreadId.parse("discovery"),
    cwd: process.cwd(),
    signal: new AbortController().signal,
    onFrame() {},
    onExit() {},
  };
  await expect(createAcpAdapter().openSession(ctx)).rejects.toThrow("user-installed");
  await expect(
    createAcpAdapter(undefined, { command: "/ace/missing/cli" }).openSession(ctx),
  ).rejects.toThrow("not found");
});
