import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { antigravityQuirks, createAcpAdapter } from "@ace/adapter-acp";
import { AcpIdentity } from "@ace/protocol";
import { INTERRUPT_GRACE_MS } from "../liveness/stop.ts";
import { cleanupRecovery, fixture } from "./recovery-test-support.ts";
import { scriptFrames } from "./test-support.ts";

/*
 * A Stop always settles (ADR 0052), even over work the provider can't stop: an Antigravity
 * shell that outlives a normal reply is reported unstoppable and blocks new prompts while it
 * runs, and its prompt already ended, so the Stop's cancel reaches nothing.
 */
afterEach(cleanupRecovery);

// The ACP double: "antigravity-shell" ends the prompt and leaves its shell running for good.
const server = fileURLToPath(
  new URL(
    "../../../../packages/adapter-acp/src/testing/uncertain-shell-server.ts",
    import.meta.url,
  ),
);

test("a Stop over an Antigravity shell that outlived its reply closes the session once its grace runs out", async () => {
  const frames = scriptFrames();
  const h = await fixture([], frames, {
    provider: "antigravity",
    capabilities: antigravityQuirks.capabilities("1.2.1"),
    permissionSettings: async () => ({ access: "full-access" as const }),
  });
  h.registry.register(
    createAcpAdapter(antigravityQuirks, {
      // The release ace admits, so the session's saved conversation loads again after a close.
      resolveLaunch: async () => ({
        identity: AcpIdentity.parse({
          acpAgentId: "antigravity",
          installationId: "test-install",
          instanceId: "test-instance",
        }),
        version: "1.2.1",
        command: process.execPath,
        args: [server],
        env: {},
      }),
      acceptsIdentity: () => true,
    }),
    { installed: true, auth: "logged_in", loginHint: "", version: "1.2.1" },
  );
  const running = () =>
    Object.values(h.store.snapshotThread(id).backgroundTasks).filter(
      (task) => task.status === "running",
    );
  const id = await h.create("antigravity-shell");
  await expect.poll(() => running().length).toBe(1);
  expect(h.store.getThread(id)?.status).toMatchObject({ state: "waiting" });

  expect(h.command({ type: "thread.interrupt", threadId: id, cascade: true }).ok).toBe(true);
  await h.engine.flush();
  // Within its grace the shell may still end by itself: the thread waits on it.
  expect(running()).toHaveLength(1);
  expect(h.store.getThread(id)?.status).toMatchObject({ state: "waiting" });

  h.clock.advance(h.clock.now() + INTERRUPT_GRACE_MS);
  await expect.poll(() => running().length).toBe(0);
  await expect.poll(() => h.store.getThread(id)?.status.state).toBe("done");
  // The person can carry on: the next message is taken, in a session opened for it.
  expect(
    h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "next" }] }).ok,
  ).toBe(true);
  await h.engine.flush();
  await expect.poll(() => h.engine.queue(id).pendingCount).toBe(0);
  expect(h.engine.queue(id).lastFailure).toBeNull();
});
