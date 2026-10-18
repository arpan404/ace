import { latest, native, until } from "./test-native.ts";
import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { PatchPump } from "./patches.ts";
import { ComposeActions } from "./compose-actions.ts";

/*
 * New thread and Add project over the real SDK and an in-process fake daemon, with the
 * production pump and a test host standing in for Swift. No provider CLI runs: the fixture's
 * Cursor sign-in has expired and Antigravity isn't installed.
 */

const pump = new PatchPump();
native.ack = (accepted) => pump.ack(accepted);
const sent: string[] = [];
let client: ClientCore | undefined;
let sidebar: { release(): void } | undefined;

afterEach(async () => {
  sidebar?.release();
  await client?.close();
  client = undefined;
  native.frames.length = 0;
  sent.length = 0;
});

async function connect(daemon: FakeDaemon): Promise<ComposeActions> {
  let saved: string | null = null;
  const owner = new ClientCore({
    deviceId: DeviceId.parse("ios-compose-test"),
    expectedHostId: HostId.parse("ios-test-host"),
    transport: () => {
      const inner = fakeTransport(daemon);
      return {
        open: (events) => inner.open(events),
        send: (text) => {
          sent.push(text);
          inner.send(text);
        },
        close: () => inner.close(),
      };
    },
    credential: async () => ({ token: "ios-test-token" }),
    storage: {
      load: async () => saved,
      save: async (value) => {
        saved = value;
      },
    },
    scheduler: {
      set: (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    id: () => crypto.randomUUID(),
    random: () => 0.5,
    now: () => Date.now(),
  });
  client = owner;
  void owner.start();
  // The inbox follows the thread list from launch, as `followInbox` does in the app.
  sidebar = owner.threads();
  await until(() => owner.state === "ready");
  return new ComposeActions(
    owner,
    pump,
    (text, limit) => text.slice(0, limit),
    () => Date.now(),
  );
}

function fixture(): FakeDaemon {
  const daemon = new FakeDaemon({
    clock: Date.now,
    hostId: "ios-test-host",
    token: "ios-test-token",
  });
  daemon.createThread({
    id: "ios-existing",
    workspaceId: "ace",
    title: "Existing",
    provider: "claude",
  });
  return daemon;
}

/** The `thread.create` commands this phone put on the wire, by command id. */
const creates = () =>
  new Set(
    sent.flatMap((text) => {
      const message = JSON.parse(text) as {
        command?: { id?: string; payload?: { type?: string } };
      };
      return message.command?.payload?.type === "thread.create" ? [message.command.id] : [];
    }),
  );

async function readyAgents(compose: ComposeActions) {
  compose.compose({ kind: "open" });
  return until(() => latest("compose.agents")?.state === "ready" && latest("compose.agents"));
}

test("a new thread sent twice from the same draft is admitted once and starts one thread", async () => {
  const daemon = fixture();
  const compose = await connect(daemon);
  const agents = await readyAgents(compose);
  const start = agents.start as { provider: string; model: string } | null;
  expect(start?.provider).toBe("claude");
  const create = {
    kind: "create",
    commandId: "draft-command-0001",
    workspaceId: "ace",
    provider: start?.provider,
    model: start?.model,
    mode: "local",
    text: "Tidy the README @README.md",
  };
  expect(compose.compose(create)).toBe(true);
  expect(compose.compose(create)).toBe(true);
  const admission = await until(() => latest("admission", "draft-command-0001"));
  expect(admission.ok).toBe(true);
  const started = await until(() => latest("compose.start", "draft-command-0001"));
  expect(started.ok).toBe(true);
  const threadId = String(started.threadId);
  // Sent again after the receipt, the same draft replays the same command, not a new one.
  compose.compose(create);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect([...creates()]).toEqual(["draft-command-0001"]);
  const listed = await until(() => client?.cachedThreads()?.thread(threadId));
  expect(listed.workspaceId).toBe("ace");
  expect(listed.title).toContain("Tidy the README");
});

test("a coding agent whose sign-in expired can't be chosen though it lists models: nothing is sent", async () => {
  const compose = await connect(fixture());
  const agents = await readyAgents(compose);
  const cursor = (agents.providers as { provider: string; ready: boolean; reason: string }[]).find(
    (row) => row.provider === "cursor",
  );
  expect(cursor).toMatchObject({ ready: false, reason: "Needs attention on your computer" });
  expect((cursor as unknown as { models: unknown[] }).models.length).toBeGreaterThan(0);
  compose.compose({
    kind: "create",
    commandId: "draft-command-0002",
    workspaceId: "ace",
    provider: "cursor",
    mode: "local",
    text: "Start on Cursor",
  });
  const admission = await until(() => latest("admission", "draft-command-0002"));
  expect(admission).toMatchObject({
    ok: false,
    message: "Cursor: Needs attention on your computer",
  });
  expect(creates().size).toBe(0);
});

test("projects with threads come first, and file mentions search the project before it has one", async () => {
  const compose = await connect(fixture());
  compose.compose({ kind: "projects" });
  const projects = await until(
    () => latest("compose.projects")?.state === "ready" && latest("compose.projects"),
  );
  expect((projects.projects as { id: string; recent: boolean }[])[0]).toMatchObject({
    id: "ace",
    recent: true,
  });
  compose.compose({ kind: "mentions", workspaceId: "ace", query: "outbox" });
  const mentions = await until(
    () => latest("compose.mentions")?.state === "ready" && latest("compose.mentions"),
  );
  expect((mentions.paths as string[]).some((path) => path.endsWith("outbox.ts"))).toBe(true);
});

test("an existing folder on the computer is found, added as a project and offered next", async () => {
  const daemon = fixture();
  daemon.projects.seedFolders("/home/ada", [{ path: "/home/ada/code/notes", git: true }]);
  const compose = await connect(daemon);
  compose.compose({ kind: "folders", query: "notes" });
  const found = await until(
    () => latest("compose.folders")?.state === "ready" && latest("compose.folders"),
  );
  const folder = (found.folders as { name: string; path: string; project: boolean }[]).find(
    (row) => row.name === "notes",
  );
  expect(folder).toMatchObject({ path: "/home/ada/code/notes", project: false });
  compose.compose({ kind: "addProject", path: "/home/ada/code/notes", requestId: "add-notes" });
  expect((await until(() => latest("admission", "add-notes"))).ok).toBe(true);
  const added = await until(() => latest("compose.added", "add-notes"));
  expect(added.ok).toBe(true);
  compose.compose({ kind: "projects" });
  const projects = await until(() => {
    const patch = latest("compose.projects");
    return patch?.state === "ready" && patch;
  });
  expect((projects.projects as { id: string }[]).map((row) => row.id)).toContain(added.projectId);
});
