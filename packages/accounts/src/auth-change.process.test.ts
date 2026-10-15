import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { spawnSupervised } from "@ace/provider-kit/process";
import { ThreadId } from "@ace/protocol";
import type { SessionContext } from "@ace/engine-api";
import { AccountService, ProviderLoginFailure, createInstance, openRegistry } from "./index.ts";

async function codexAccount(stuck = false) {
  const home = await mkdtemp(join(tmpdir(), "auth-change-"));
  const registry = await openRegistry(join(home, "accounts.sqlite"));
  await registry.register(
    createInstance({ id: "work", provider: "codex", label: "Work", homeDir: join(home, "work") }),
  );
  const service = new AccountService({ registry, now: () => 1, timeZone: "UTC", env: {} });
  const exits: { thread: string; deliberate: boolean }[] = [];
  let live = 0;
  const processes: ReturnType<typeof spawnSupervised>[] = [];
  const bound = service.bindAdapter({
    provider: "codex",
    capabilities: () => {
      throw new Error("unused");
    },
    createTranslator: () => {
      throw new Error("unused");
    },
    create: (env) => ({
      openSession: async (context: SessionContext) => {
        // A real provider process per session; closing it is what ends the thread's session.
        const proc = spawnSupervised({
          command: process.execPath,
          args: ["-e", "process.stdin.resume()"],
          env,
          name: "codex-session",
        });
        live++;
        processes.push(proc);
        void proc.exited.then((exit) => {
          live--;
          context.onExit({ deliberate: exit.reason === "stopped" });
        });
        return {
          nativeSessionId: `native-${context.threadId}`,
          send: async () => {},
          interrupt: async () => {},
          resolve: async () => {},
          stopTask: async () => {},
          close: async () => {
            if (stuck) throw new Error("provider did not exit");
            await proc.stop({ graceMs: 0 });
          },
        };
      },
    }),
  });
  const open = (thread: string) =>
    bound.openSession({
      instanceId: "work",
      threadId: ThreadId.parse(thread),
      cwd: home,
      signal: new AbortController().signal,
      onFrame: () => {},
      onExit: (exit) => exits.push({ thread, deliberate: exit.deliberate }),
    });
  return {
    service,
    open,
    exits,
    live: () => live,
    async close() {
      await Promise.all(processes.map((proc) => proc.stop({ graceMs: 0 })));
      registry.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("signing in or out of an account stops its open threads first, then admits threads again once released", async () => {
  const account = await codexAccount();
  try {
    await account.open("thread-a");
    await account.open("thread-b");
    expect(() => account.service.reserveAccountChange("work")).toThrow("Instance is busy");

    const release = await account.service.reserveAuthChange("work");
    expect(account.live()).toBe(0);
    expect(account.exits).toEqual(
      expect.arrayContaining([
        { thread: "thread-a", deliberate: true },
        { thread: "thread-b", deliberate: true },
      ]),
    );
    // While the credential changes, no thread can start on the old one.
    await expect(account.open("thread-c")).rejects.toThrow("migrating");
    release();
    await account.open("thread-c");
    expect(account.live()).toBe(1);
  } finally {
    await account.close();
  }
});

test("an account whose thread won't stop keeps its credential and says why", async () => {
  const account = await codexAccount(true);
  try {
    await account.open("thread-a");
    const failure = await account.service.reserveAuthChange("work").catch((error) => error);
    expect(failure).toBeInstanceOf(ProviderLoginFailure);
    expect(String(failure.message)).toMatch(/didn't stop, so ace left the sign-in unchanged/);
    // The failed change releases its fence, so other threads keep working.
    expect(account.service.isChangingAccount("work")).toBe(false);
  } finally {
    await account.close();
  }
});
