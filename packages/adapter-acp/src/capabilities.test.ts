import { ThreadId } from "@ace/protocol";
import { it, expect } from "vitest";
import { cursorAdapter, antigravityAdapter, createAcpAdapter, antigravityQuirks } from "./index.ts";
it("enables Cursor controls only for a discovered version with recorded support", () => {
  const cli = { installed: true, auth: "unknown" as const, loginHint: "agent login" };
  expect(cursorAdapter.capabilities(cli).subagentTranscripts).toBe(false);
  expect(cursorAdapter.capabilities({ ...cli, version: "2026.09.26-dd393fe" })).toMatchObject({
    subagentTranscripts: true,
    interruptCascades: true,
    resume: true,
    steer: false,
    backgroundVisibility: "none",
  });
  expect(cursorAdapter.capabilities({ ...cli, version: "2025.01.01-older" }).resume).toBe(false);
});
it("keeps Antigravity experimental and limits controls to known server versions", () => {
  const cli = { installed: true, auth: "unknown" as const, loginHint: "server configuration" };
  expect(antigravityQuirks.experimental).toBe(true);
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
