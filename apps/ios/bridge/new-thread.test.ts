import { latest, native, until } from "./test-host.ts";
import { createHash } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId, ProviderConfigurations } from "@ace/protocol";
import { PatchPump } from "./patches.ts";
import { ComposeActions } from "./compose-actions.ts";
import { threadRow } from "./presentation.ts";
import { NativeReads } from "./native-reads.ts";
import type { NewThreadMemory } from "./new-thread.ts";
import type { ChunkReader } from "./thread-attachments.ts";

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

async function connect(
  daemon: FakeDaemon,
  chunks?: ChunkReader,
  memory?: (owner: ClientCore) => NewThreadMemory,
): Promise<ComposeActions> {
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
    chunks,
    memory?.(owner),
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

/** The `thread.create` payloads this phone put on the wire. */
const createPayloads = () =>
  sent.flatMap((text) => {
    const message = JSON.parse(text) as {
      command?: { payload?: Record<string, unknown> & { type?: string } };
    };
    return message.command?.payload?.type === "thread.create" ? [message.command.payload] : [];
  });

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

const photo = Buffer.alloc(70 * 1024, 9);
const photoSha = createHash("sha256").update(photo).digest("hex");
const staged: ChunkReader = async (_localId, offset, limit) =>
  photo.subarray(offset, offset + limit).toString("base64");
const picked = {
  localId: "photo-new-0001",
  name: "sketch.png",
  mimeType: "image/png",
  bytes: photo.length,
  sha256: photoSha,
};
type Attachments = { files: { state: string }[]; blocked: string | null };

test("the first message carries its photo, speed, effort and access, and the thread takes the files", async () => {
  const compose = await connect(fixture(), staged);
  await readyAgents(compose);
  const model = "simulated-ultra-reasoning-extended-context-demonstration-model";
  compose.compose({ kind: "choice", workspaceId: "ace", provider: "codex", access: "read-only" });
  const access = await until(() => {
    const patch = latest("compose.access");
    return patch?.provider === "codex" && patch.state === "ready" && patch;
  });
  expect(access.selected).toBe("read-only");
  expect((access.choices as { mode: string }[]).map((choice) => choice.mode)).toContain(
    "full-access",
  );
  compose.compose({ kind: "attach", workspaceId: "ace", file: picked });
  compose.compose({
    kind: "create",
    commandId: "draft-command-0010",
    workspaceId: "ace",
    provider: "codex",
    model: `codex\u0000${model}`,
    mode: "local",
    text: "Too soon",
  });
  const early = await until(() => latest("admission", "draft-command-0010"));
  expect(early).toMatchObject({ ok: false, message: "Wait for your files to finish uploading." });
  await until(
    () => (latest("compose.attachments") as Attachments | undefined)?.files[0]?.state === "ready",
  );
  expect((latest("compose.attachments") as Attachments).blocked).toBeNull();
  const agents = latest("compose.agents") as {
    providers: { provider: string; models: { key: string; speeds: { speed: string }[] }[] }[];
  };
  const tuned = agents.providers
    .find((row) => row.provider === "codex")
    ?.models.find((row) => row.speeds.some((tier) => tier.speed === "fast"));
  expect(tuned).toBeDefined();
  compose.compose({
    kind: "create",
    commandId: "draft-command-0011",
    workspaceId: "ace",
    provider: "codex",
    model: tuned?.key,
    effort: "high",
    speed: "fast",
    access: "read-only",
    mode: "local",
    text: "What does this sketch need?",
  });
  expect((await until(() => latest("admission", "draft-command-0011"))).ok).toBe(true);
  const started = await until(() => latest("compose.start", "draft-command-0011"));
  expect(started.ok).toBe(true);
  const payload = createPayloads().at(-1);
  expect(payload).toMatchObject({
    access: "read-only",
    options: { effort: "high", serviceTier: expect.any(String) },
    context: { attachments: [{ sha256: photoSha }] },
  });
  expect((payload?.context as { draftId?: string } | undefined)?.draftId).toBeTruthy();
  expect((latest("compose.attachments") as Attachments).files).toEqual([]);
  // Closing the sheet after the start leaves the files with the thread: no draft release.
  compose.compose({ kind: "close" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(sent.some((text) => text.includes('"op":"draft.release"'))).toBe(false);
});

test("a first message of only files starts the thread; one with nothing is refused", async () => {
  const compose = await connect(fixture(), staged);
  const agents = await readyAgents(compose);
  const start = agents.start as { provider: string; model: string };
  const create = (commandId: string) => ({
    kind: "create",
    commandId,
    workspaceId: "ace",
    provider: start.provider,
    model: start.model,
    mode: "local",
    text: "",
  });
  compose.compose(create("draft-command-0020"));
  expect(await until(() => latest("admission", "draft-command-0020"))).toMatchObject({
    ok: false,
    message: "Write the first message or attach a file.",
  });
  compose.compose({ kind: "attach", workspaceId: "ace", file: picked });
  await until(
    () => (latest("compose.attachments") as Attachments | undefined)?.files[0]?.state === "ready",
  );
  compose.compose(create("draft-command-0021"));
  expect((await until(() => latest("compose.start", "draft-command-0021"))).ok).toBe(true);
  expect(createPayloads().at(-1)).toMatchObject({
    input: [{ type: "text", text: "" }],
    context: { attachments: [{ sha256: photoSha }] },
  });
});

test("the picker keeps its order when a model is picked and leaves out CLIs not installed", async () => {
  const compose = await connect(fixture());
  const agents = await readyAgents(compose);
  type Row = { provider: string; models: { key: string; account: string }[]; lead: number };
  const rows = agents.providers as Row[];
  expect(rows.some((row) => row.provider === "antigravity")).toBe(false);
  const codex = rows.find((row) => row.provider === "codex");
  expect(codex && codex.lead).toBeGreaterThan(0);
  expect(codex && codex.lead).toBeLessThanOrEqual(codex?.models.length ?? 0);
  const last = codex?.models.at(-1);
  expect(codex?.models[0]?.key).not.toBe(last?.key);
  compose.compose({ kind: "choice", provider: "codex", model: last?.key, account: last?.account });
  const afterPick = await until(() => {
    const row = (latest("compose.agents")?.providers as Row[] | undefined)?.find(
      (entry) => entry.provider === "codex",
    );
    return row?.lead === row?.models.length && row;
  });
  expect(afterPick.models.map((model) => model.key)).toEqual(
    codex?.models.map((model) => model.key),
  );
});

test("the picker has Favorites and one tab per account, and a star is saved where the web keeps it", async () => {
  const daemon = fixture();
  const compose = await connect(daemon);
  const agents = await readyAgents(compose);
  type Tab = { id: string; provider: string | null; models: { key: string; account: string }[] };
  const tabs = agents.tabs as Tab[];
  expect(tabs[0]?.id).toBe("favorites");
  expect(tabs[0]?.models).toEqual([]);
  const codex = tabs.filter((tab) => tab.provider === "codex");
  expect(codex.length).toBeGreaterThan(0);
  for (const tab of codex) expect(new Set(tab.models.map((model) => model.account)).size).toBe(1);
  const starred = codex[0]?.models[0];
  compose.compose({ kind: "favorite", key: starred?.key });
  const saved = await until(() => {
    const patch = latest("compose.agents");
    return (patch?.favorites as string[] | undefined)?.includes(starred?.key ?? "") && patch;
  });
  expect((saved.tabs as Tab[])[0]?.models.map((model) => model.key)).toEqual([starred?.key]);
  const reply = await client?.request({
    type: "settings.get",
    key: "providers.configuration",
    scope: {},
  });
  const rows = ProviderConfigurations.parse(reply?.entries[0]?.value ?? []);
  const own = rows.find((row) => row.provider === "codex" && !row.instance);
  expect(own?.favourites?.length).toBe(1);
  compose.compose({ kind: "favorite", key: starred?.key });
  await until(() => (latest("compose.agents")?.favorites as string[] | undefined)?.length === 0);
});

test("access the provider can't express is never loosened: Send waits with the reason", async () => {
  const compose = await connect(fixture());
  const agents = await readyAgents(compose);
  const cursor = (agents.providers as { provider: string }[]).some(
    (row) => row.provider === "cursor",
  );
  expect(cursor).toBe(true);
  compose.compose({ kind: "choice", provider: "cursor", access: "read-only" });
  const access = await until(() => {
    const patch = latest("compose.access");
    return patch?.provider === "cursor" && patch.state === "ready" && patch;
  });
  expect(access.selected).toBeNull();
  expect(access.problem).toBe(
    "Cursor has nothing as strict as Read-only. Choose its access before sending.",
  );
});

test("a thread started from an issue links that issue", async () => {
  const daemon = fixture();
  const compose = await connect(daemon);
  const agents = await readyAgents(compose);
  const start = agents.start as { provider: string; model: string } | null;
  const issue = {
    repository: { forge: "github", host: "github.com", owner: "acme", name: "ace" },
    number: 240,
  };
  compose.compose({
    kind: "create",
    commandId: "draft-issue-0001",
    workspaceId: "ace",
    provider: start?.provider,
    model: start?.model,
    mode: "local",
    text: "Work on GitHub issue #240: Sidebar loses its scroll position",
    issue,
  });
  await until(() => latest("admission", "draft-issue-0001"));
  expect(createPayloads().at(-1)).toMatchObject({
    type: "thread.create",
    workspaceId: "ace",
    issue,
  });
});

test("New thread opens again on its last projects and agents, and keeps them when the reread fails", async () => {
  const daemon = fixture();
  const compose = await connect(
    daemon,
    undefined,
    (owner) => new NativeReads(owner, pump, { now: () => Date.now(), schedule: () => () => {} }),
  );
  compose.compose({ kind: "open" });
  const projects = await until(
    () => latest("compose.projects")?.state === "ready" && latest("compose.projects"),
  );
  const agents = await until(
    () => latest("compose.agents")?.state === "ready" && latest("compose.agents"),
  );
  compose.compose({ kind: "close" });
  daemon.failRequests("workspace.request", "providers.request");
  const reopened = native.frames.length;
  compose.compose({ kind: "open" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const since = native.frames.slice(reopened);
  expect(since.some((frame) => frame.type === "compose.projects" && frame.state !== "ready")).toBe(
    false,
  );
  expect(since.some((frame) => frame.type === "compose.agents" && frame.state !== "ready")).toBe(
    false,
  );
  expect(latest("compose.projects")?.projects).toEqual(projects.projects);
  expect(latest("compose.agents")?.providers).toEqual(agents.providers);
});

test("a chat with no project starts in its own hidden project, with its photo, and reads as a chat", async () => {
  const compose = await connect(fixture(), staged);
  const agents = await readyAgents(compose);
  const start = agents.start as { provider: string; model: string };
  const chat = (commandId: string, text: string) => ({
    kind: "create",
    commandId,
    workspaceId: "chat",
    provider: start.provider,
    model: start.model,
    mode: "worktree",
    text,
  });
  compose.compose({ kind: "attach", workspaceId: "chat", file: picked });
  const attached = await until(() => {
    const patch = latest("compose.attachments") as
      | (Attachments & { workspaceId: string })
      | undefined;
    return patch?.files[0]?.state === "ready" && patch;
  });
  expect(attached.workspaceId).toBe("chat");
  compose.compose(chat("chat-command-0001", "What's a semaphore?"));
  const started = await until(() => latest("compose.start", "chat-command-0001"));
  expect(started.ok).toBe(true);
  const first = createPayloads().at(-1);
  const thread = await until(() => client?.cachedThreads()?.thread(String(started.threadId)));
  expect(threadRow(thread)).toMatchObject({ chat: true, project: "Chat", badge: "" });
  // A chat runs in its own folder: never a worktree, whatever the draft held.
  expect(first).toMatchObject({ mode: "local", context: { attachments: [{ sha256: photoSha }] } });
  compose.compose(chat("chat-command-0002", "And a mutex?"));
  expect((await until(() => latest("compose.start", "chat-command-0002"))).ok).toBe(true);
  const second = createPayloads().at(-1);
  expect(first?.workspaceId).not.toBe("chat");
  expect(second?.workspaceId).not.toBe(first?.workspaceId);
  // Neither chat's hidden project is offered as a project.
  compose.compose({ kind: "projects" });
  const projects = await until(() => {
    const patch = latest("compose.projects");
    return patch?.state === "ready" && patch;
  });
  const ids = (projects.projects as { id: string }[]).map((row) => row.id);
  expect(ids).toContain("ace");
  expect(ids).not.toContain(first?.workspaceId);
  expect(ids).not.toContain(second?.workspaceId);
});
