import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ThreadId } from "@ace/protocol";
import { openRegistry, createInstance, AccountService, bindCursorSdk } from "./index.ts";

const fenceControl = vi.hoisted(() => ({ failStop: false, failClose: false }));

// The fence bookkeeping under test lives in bindCursorSdk; the adapter itself is a
// scripted double so a refused host exit is deterministic without wedging real hosts.
vi.mock("@ace/adapter-cursor/adapter", () => ({
  createCursorAdapter: (options: { instance?: { id: string } }) => {
    if (!options?.instance)
      return { capabilities: () => ({}), createTranslator: () => ({}), close: async () => {} };
    return {
      provider: "cursor",
      backend: "cursor-sdk",
      capabilities: () => ({}),
      createTranslator: () => ({}),
      openSession: async () => ({ close: async () => {}, send: async () => {} }),
      stopInstance: async () => {
        if (fenceControl.failStop) throw new Error("synthetic host stop failure");
      },
      close: async () => {
        if (fenceControl.failClose) throw new Error("SDK shutdown incomplete");
      },
    };
  },
}));

async function fencedBinding(home: string, id: string) {
  const registry = await openRegistry(join(home, "accounts.sqlite"));
  const service = new AccountService({
    registry,
    now: () => 1,
    timeZone: "UTC",
    env: {},
    cursorEnv: {},
  });
  const bound = bindCursorSdk(service, {});
  await registry.register(
    createInstance({ id, provider: "cursor", label: id, homeDir: join(home, id) }),
  );
  const context = (thread: string) => ({
    instanceId: id,
    threadId: ThreadId.parse(thread),
    cwd: home,
    signal: new AbortController().signal,
    onFrame: () => {},
    onExit: () => {},
  });
  return { registry, bound, context };
}

it("a refused host exit still releases the instance fence so later sends open fresh owners", async () => {
  const home = await mkdtemp(join(tmpdir(), "cursor-fence-"));
  const { registry, bound, context } = await fencedBinding(home, "fenced");
  try {
    await bound.openSession(context("thread-1"));
    await bound.stopInstance("fenced");
    expect(bound.isFenced("fenced")).toBe(true);
    fenceControl.failClose = true;
    await expect(bound.rebindInstance("fenced")).rejects.toThrow("SDK shutdown incomplete");
    // The close failure still surfaces, but the account is usable again instead of meeting
    // a stale fence with sign-in instructions on every later send.
    expect(bound.isFenced("fenced")).toBe(false);
    fenceControl.failClose = false;
    await bound.openSession(context("thread-2"));
    expect(bound.isFenced("fenced")).toBe(false);
  } finally {
    fenceControl.failClose = false;
    fenceControl.failStop = false;
    await bound.close().catch(() => {});
    registry.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("a failed host stop releases the fence because no credential changed", async () => {
  const home = await mkdtemp(join(tmpdir(), "cursor-fence-stop-"));
  const { registry, bound, context } = await fencedBinding(home, "unstoppable");
  try {
    await bound.openSession(context("thread-1"));
    fenceControl.failStop = true;
    await expect(bound.stopInstance("unstoppable")).rejects.toThrow("synthetic host stop failure");
    expect(bound.isFenced("unstoppable")).toBe(false);
  } finally {
    fenceControl.failClose = false;
    fenceControl.failStop = false;
    await bound.close().catch(() => {});
    registry.close();
    await rm(home, { recursive: true, force: true });
  }
});
