// A process test: the real daemon's startup, account index and session opening together. The pure
// waiting and checking rules are covered in packages/accounts; this guards their wiring (ADR 0175).
import { afterEach, expect, test, vi } from "vitest";
import { prepareDaemonHome } from "@ace/service";
import { mkdtemp, rm, realpath, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInstance, openRegistry, type HomeCheck } from "@ace/accounts";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { Command, type ThreadId } from "@ace/protocol";
import { startDaemon, AdapterRegistry } from "./index.ts";
import { commandContext } from "./commands.ts";
import { scriptFrames, start, end } from "./engine/test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

const capabilities = {
  steer: false,
  interruptCascades: false,
  resume: true,
  fork: false,
  subagentTranscripts: false,
  backgroundTaskControl: false,
  backgroundVisibility: "none" as const,
  planMode: false,
  tokenUsage: false,
  imageInput: false,
  rewindFiles: false,
};

test("an account folder that never answers leaves the daemon up, other accounts working, and its own thread waiting until it does", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-account-stall-"));
  prepareDaemonHome(home);
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const accounts = ["work", "personal"].map((id) =>
    createInstance({ id, provider: "codex", label: id, homeDir: join(home, id) }),
  );
  const registry = await openRegistry(join(home, "accounts.sqlite"));
  for (const account of accounts) {
    await mkdir(account.homeDir);
    await registry.register(account);
  }
  registry.close();

  // The work folder's stat never returns until the test lets it: a stalled disk or share.
  const answer = Promise.withResolvers<void>();
  const check: HomeCheck = (instance, next) =>
    instance.id === "work" ? answer.promise.then(() => next(instance)) : next(instance);
  const opened: { instance: string | undefined; home: string | undefined }[] = [];
  const frames = scriptFrames();
  const frame = frames.frame(start, end);
  const payload = new ProviderPayload(JSON.stringify(frame.data));
  const scripted = createScriptedAdapter({
    provider: "codex",
    nativeSessionId: "native",
    capabilities,
    createTranslator: () => ({ translate: frames.translate, tick: () => [] }),
    steps: [{ on: "send", frames: [{ ...frame, payload, data: payload.data }] }],
  });
  const adapters = new AdapterRegistry();
  adapters.register(
    {
      ...scripted,
      async openSession(context) {
        opened.push({ instance: context.instanceId, home: context.env?.["CODEX_HOME"] });
        return scripted.openSession(context);
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  const daemon = await startDaemon({
    config: {
      dataDir: home,
      host: "127.0.0.1",
      port: 0,
      remotePort: 0,
      listen: "local",
      logLevel: "silent",
    },
    engine: { registry: adapters },
    accounts: {
      env: process.env,
      homeChecks: { check, patienceMs: 10 },
      homeWait: { noticeMs: 50 },
    },
  });
  cleanup.push(() => daemon.close());
  // Listening while the work folder still hasn't answered.
  expect(daemon.url).toMatch(/^ws:/);

  const workspaceId = daemon.store.createWorkspace(home, "workspace");
  const create = (instanceId: string) => {
    const threadId = randomUUID() as ThreadId;
    const command = Command.parse({
      id: randomUUID(),
      deviceId: "host",
      createdAt: 1,
      payload: {
        type: "thread.create",
        threadId,
        workspaceId,
        provider: "codex",
        instanceId,
        input: [{ type: "text", text: "synthetic" }],
      },
    });
    expect(daemon.engine?.handler.handle(command, commandContext(daemon.store)).ok).toBe(true);
    return threadId;
  };

  const personal = create("personal");
  await vi.waitFor(() => expect(daemon.store.getThread(personal)?.status.state).toBe("done"));

  const work = create("work");
  await vi.waitFor(() =>
    expect(Object.values(daemon.store.snapshotThread(work).items)).toContainEqual(
      expect.objectContaining({ type: "notice", code: "account_home_waiting" }),
    ),
  );
  expect(daemon.store.getThread(work)?.status.state).not.toBe("done");
  // Nothing ran the work thread anywhere else meanwhile.
  expect(opened.map(({ instance }) => instance)).toEqual(["personal"]);

  answer.resolve();
  await vi.waitFor(() => expect(daemon.store.getThread(work)?.status.state).toBe("done"));
  expect(opened).toEqual([
    { instance: "personal", home: await realpath(join(home, "personal")) },
    { instance: "work", home: await realpath(join(home, "work")) },
  ]);
});
