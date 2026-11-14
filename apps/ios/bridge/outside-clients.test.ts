import { afterEach, expect, test } from "vitest";
import { OutsideGrantEntry, WorkspaceId, type DeviceScope } from "@ace/protocol";
import { answerOutside, OutsideWatch } from "./outside-clients.ts";
import { plainPreview, RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

/*
 * Outside apps on the phone (ADR 0122), over a real client and the fake daemon: a pending
 * sign-in reaches the approval sheet with read fixed on and the rest off, the person's choice
 * reaches the machine with read always included, connected apps list in words, and a phone
 * that isn't the machine's administrator is told so and never watches.
 */

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
const day = 24 * 60 * 60_000;
/** The phone's clock. */
const now = 1_000;

async function connected(scopes?: readonly DeviceScope[]) {
  const { daemon, client } = sheetFixture(scopes ? { scopes } : {});
  await client.start();
  await until(() => client.state === "ready", "the client connects");
  const sink = new RecordingSink();
  const watch = new OutsideWatch(client, sink, plainPreview, () => now);
  watch.start();
  closers.push(
    () => watch.stop(),
    () => client.close(),
  );
  const state = () =>
    sink.read(OutsideWatch.key) as
      | {
          access: {
            requestId: string;
            clientName: string;
            domain: string;
            verified: boolean;
            matchCode: string;
            choices: { scope: string; on: boolean; fixed: boolean; asked: boolean }[];
            expiry: string;
          }[];
          screen: { grantId: string; name: string; line: string }[];
          opened: { n: number; requestId: string; ended: string | null } | null;
        }
      | undefined;
  return { daemon, client, sink, state, watch };
}

const grant = (overrides: Record<string, unknown> = {}): OutsideGrantEntry =>
  OutsideGrantEntry.parse({
    id: "g1",
    clientKind: "cimd",
    clientId: "https://claude.ai/oauth/client.json",
    name: "Claude",
    domain: "claude.ai",
    scopes: ["threads:read", "threads:start"],
    projects: "all",
    createdAt: 100,
    expiresAt: 30 * day,
    lastUsedAt: 500,
    revokedAt: null,
    approvedBy: "phone",
    started: ["t1", "t2"],
    messaged: [],
    ...overrides,
  });

test("a pending sign-in reaches the sheet with read fixed on and asked access marked", async () => {
  const { daemon, state } = await connected();
  daemon.outside.ask({
    requestId: "r1",
    clientName: "Claude",
    domain: null,
    scopes: ["threads:read", "threads:start", "computer"],
    matchCode: "7KQ2XM",
    expiresAt: Number.MAX_SAFE_INTEGER,
    redirectHost: "127.0.0.1",
    redirectKind: "this-device",
  });
  await until(() => state()?.access.length === 1, "the sign-in arrives");
  const [request] = state()?.access ?? [];
  expect(request).toMatchObject({
    clientName: "Claude",
    domain: "unverified",
    verified: false,
    matchCode: "7KQ2XM",
    expiry: "month",
    redirect:
      "The code goes to an app on the device where the sign-in started. Approve only if you started it.",
  });
  expect(request?.choices.filter((choice) => choice.on).map((choice) => choice.scope)).toEqual([
    "threads:read",
  ]);
  expect(request?.choices.filter((choice) => choice.asked).map((choice) => choice.scope)).toEqual([
    "threads:read",
    "threads:start",
    "computer",
  ]);
});

test("approving sends the chosen access with read included, and the sheet's request goes", async () => {
  const { daemon, client, state } = await connected();
  daemon.outside.ask({
    requestId: "r1",
    clientName: "Claude",
    domain: "claude.ai",
    scopes: ["threads:read", "threads:start"],
    matchCode: "7KQ2XM",
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
  await until(() => state()?.access.length === 1, "the sign-in arrives");
  const answer = await answerOutside(
    client,
    {
      type: "native.outside",
      machine: "studio",
      request: {
        op: "decide",
        requestId: "r1",
        approve: true,
        scopes: ["threads:start"],
        projects: [WorkspaceId.parse("ws-a")],
        expiry: "day",
      },
    },
    // The phone's clock reads fractions of a millisecond.
    () => 1_000.5,
  );
  expect(answer).toEqual({ ok: true });
  expect(daemon.outside.decisions).toEqual([
    {
      requestId: "r1",
      choice: {
        decision: "approve",
        scopes: ["threads:read", "threads:start"],
        projects: ["ws-a"],
        expiresAt: 1_000 + day,
      },
    },
  ]);
  await until(() => state()?.access.length === 0, "the answered sign-in leaves the sheet");
});

test("answering a sign-in that already ended says so", async () => {
  const { client } = await connected();
  const answer = await answerOutside(
    client,
    {
      type: "native.outside",
      machine: "studio",
      request: { op: "decide", requestId: "gone", approve: false },
    },
    () => 1_000,
  );
  expect(answer).toEqual({
    ok: false,
    code: "not_found",
    message: "That sign-in request already ended. Ask the app to sign in again.",
  });
});

test("connected apps list live ones first, in words", async () => {
  const { daemon, client } = await connected();
  daemon.outside.grants = [
    grant({ id: "old", name: "Bot", domain: null, clientKind: "cli", revokedAt: 50 }),
    grant({
      scopes: ["threads:stop", "threads:read", "threads:start", "browser"],
      projects: ["ws-unknown"],
    }),
  ];
  const answer = (await answerOutside(
    client,
    { type: "native.outside", machine: "studio", request: { op: "grants" } },
    () => 1_000,
  )) as { ok: boolean; grants: Record<string, unknown>[] };
  expect(answer.ok).toBe(true);
  expect(answer.grants.map((row) => [row.id, row.state])).toEqual([
    ["g1", "active"],
    ["old", "revoked"],
  ]);
  expect(answer.grants[0]).toMatchObject({
    domain: "claude.ai",
    access: "Read, start and stop threads and use the browser",
    projectsLine: "ws-unknown",
    started: 2,
  });
  expect(answer.grants[1]).toMatchObject({ domain: "unverified", pasted: true });
});

test("revoking ends the grant and its screen use; Stop takes the screen away", async () => {
  const { daemon, client, state } = await connected();
  daemon.outside.grants = [grant({ scopes: ["threads:read", "computer"] })];
  daemon.outside.useScreen([{ grantId: "g1", name: "Claude", apps: ["Safari"] }]);
  await until(() => state()?.screen.length === 1, "screen use arrives");
  expect(state()?.screen[0]?.line).toMatch(/^Claude is using this (Mac|computer)$/);
  const stop = await answerOutside(
    client,
    { type: "native.outside", machine: "studio", request: { op: "stopScreen", grantId: "g1" } },
    () => 1_000,
  );
  expect(stop).toEqual({ ok: true });
  await until(() => state()?.screen.length === 0, "the line goes after Stop");
  expect(daemon.outside.grants[0]?.scopes).toEqual(["threads:read"]);
  await answerOutside(
    client,
    { type: "native.outside", machine: "studio", request: { op: "revoke", grantId: "g1" } },
    () => 1_000,
  );
  expect(daemon.outside.grants[0]?.revokedAt).not.toBeNull();
});

test("changing access keeps read and counts a new expiry from now", async () => {
  const { daemon, client } = await connected();
  daemon.outside.grants = [grant()];
  await answerOutside(
    client,
    {
      type: "native.outside",
      machine: "studio",
      request: { op: "update", grantId: "g1", scopes: ["browser"], expiry: "forever" },
    },
    () => 1_000,
  );
  expect(daemon.outside.grants[0]).toMatchObject({
    scopes: ["threads:read", "browser"],
    expiresAt: null,
    projects: "all",
  });
});

test("a phone that isn't the machine's administrator is told so and shows no sign-ins", async () => {
  const { daemon, client, sink } = await connected(["read", "operate"]);
  daemon.outside.ask({
    requestId: "r1",
    clientName: "Claude",
    domain: null,
    scopes: ["threads:read"],
    matchCode: "7KQ2XM",
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
  const answer = await answerOutside(
    client,
    { type: "native.outside", machine: "studio", request: { op: "grants" } },
    () => 1_000,
  );
  expect(answer).toMatchObject({
    ok: false,
    message: "Only an administrator of studio can manage connected apps.",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sink.read(OutsideWatch.key)).toBeUndefined();
});

test("a chat's hidden project is never offered as a project to choose", async () => {
  const { daemon, client } = await connected();
  daemon.createThread({
    id: "chat-1",
    workspaceId: "chat-1",
    title: "A chat",
    provider: "claude",
    details: {
      workspace: { id: "chat-1", name: "Chat", path: "/c/1", kind: "chat" },
      mode: "local",
    },
  });
  daemon.createThread({
    id: "t-ace",
    workspaceId: "ace",
    title: "Work",
    provider: "claude",
    details: { workspace: { id: "ace", name: "ace", path: "/w/ace" }, mode: "local" },
  });
  const answer = (await answerOutside(
    client,
    { type: "native.outside", machine: "studio", request: { op: "projects" } },
    () => 1_000,
  )) as { ok: boolean; projects: { id: string; name: string }[] };
  expect(answer.ok).toBe(true);
  expect(answer.projects.map((project) => project.id)).toContain("ace");
  expect(answer.projects.map((project) => project.id)).not.toContain("chat-1");
});

const signIn = {
  requestId: "r1",
  clientName: "Claude",
  domain: "claude.ai",
  scopes: ["threads:read" as const],
  matchCode: "7KQ2XM",
  expiresAt: now + 9 * 60_000,
};
const tap = (requestId = "r1", expiresAt = signIn.expiresAt) =>
  ({ type: "outside.open", requestId, clientName: "Claude", expiresAt }) as const;

test("tapping a sign-in alert opens the sheet on that request", async () => {
  const { daemon, state, watch } = await connected();
  daemon.outside.ask(signIn);
  await until(() => state()?.access.length === 1, "the sign-in arrives");
  watch.open(tap());
  expect(state()?.opened).toEqual({ n: 1, requestId: "r1", ended: null });
});

test("a tap on a cold launch waits for the machine, then opens the sheet", async () => {
  const { daemon, client } = sheetFixture({});
  daemon.outside.ask(signIn);
  const sink = new RecordingSink();
  const watch = new OutsideWatch(client, sink, plainPreview, () => now);
  watch.start();
  closers.push(
    () => watch.stop(),
    () => client.close(),
  );
  // Tapped before the phone has reached the machine: nothing is decided yet.
  watch.open(tap());
  const opened = () => (sink.read(OutsideWatch.key) as { opened?: unknown } | undefined)?.opened;
  expect(opened() ?? null).toBeNull();
  await client.start();
  await until(() => opened() != null, "the tapped sign-in opens");
  expect(opened()).toEqual({ n: 1, requestId: "r1", ended: null });
});

test("a tapped sign-in the machine no longer lists says it ended instead of opening a sheet", async () => {
  const { state, watch, sink } = await connected();
  await until(() => sink.read(OutsideWatch.key) !== undefined, "the machine says what is pending");
  watch.open(tap("gone"));
  expect(state()?.opened).toEqual({
    n: 1,
    requestId: "gone",
    ended: "Claude's sign-in request ended. Ask it to sign in again.",
  });
});

test("a tapped sign-in past its time says it ended, even while the machine still lists it", async () => {
  const { daemon, state, watch } = await connected();
  daemon.outside.ask({ ...signIn, expiresAt: Number.MAX_SAFE_INTEGER });
  await until(() => state()?.access.length === 1, "the sign-in arrives");
  // The alert said it ends at `now`: the phone's clock has reached it.
  watch.open(tap("r1", now));
  expect(state()?.opened?.ended).toMatch(/ended/);
  // A second tap is answered on its own.
  watch.open(tap("r1"));
  expect(state()?.opened).toEqual({ n: 2, requestId: "r1", ended: null });
});

interface AddressRow {
  path: string;
  title: string;
  url: string | null;
  state: string | null;
  problem: boolean;
  note: string | null;
  on: boolean | null;
  ownUrl: string | null;
}
const outside = (
  client: Parameters<typeof answerOutside>[0],
  request: Parameters<typeof answerOutside>[1]["request"],
) => answerOutside(client, { type: "native.outside", machine: "studio", request }, () => 1_000);
async function addresses(client: Parameters<typeof answerOutside>[0]) {
  return (await outside(client, { op: "addresses" })) as {
    ok: boolean;
    rows: AddressRow[];
    enroll: string;
  };
}

test("Connect an app lists the four addresses with what each can copy and why one can't serve", async () => {
  const { daemon, client } = await connected();
  daemon.outside.endpoints = [
    { path: "relay", url: null, on: true, problem: "Sign in to ace to use the relay" },
    { path: "local", url: "http://127.0.0.1:47811/mcp", on: true },
    { path: "tailscale", url: "https://studio.tail.ts.net/mcp", on: true },
  ];
  const answer = await addresses(client);
  expect(answer.ok).toBe(true);
  expect(answer.enroll).toBe("ace mcp enroll");
  expect(answer.rows.map((row) => [row.path, row.title, row.url, row.state])).toEqual([
    ["local", "This computer", "http://127.0.0.1:47811/mcp", "http://127.0.0.1:47811/mcp"],
    ["tailscale", "Tailscale", "https://studio.tail.ts.net/mcp", "https://studio.tail.ts.net/mcp"],
    ["relay", "ace's relay", null, "Sign in to ace to use the relay"],
    ["custom", "Your own URL", null, null],
  ]);
  expect(answer.rows.find((row) => row.path === "relay")).toMatchObject({
    problem: true,
    note: "ace cloud can read what passes through it; it keeps none of it.",
  });
  expect(answer.rows.find((row) => row.path === "local")?.on).toBeNull();
});

test("the relay and Tailscale switches save on the machine and read back", async () => {
  const { client } = await connected();
  const before = await addresses(client);
  expect(before.rows.find((row) => row.path === "relay")?.on).toBe(false);
  expect(await outside(client, { op: "setPath", path: "relay", on: true })).toEqual({ ok: true });
  expect(await outside(client, { op: "setPath", path: "tailscale", on: true })).toEqual({
    ok: true,
  });
  const after = await addresses(client);
  expect(after.rows.find((row) => row.path === "relay")?.on).toBe(true);
  expect(after.rows.find((row) => row.path === "tailscale")?.on).toBe(true);
  await outside(client, { op: "setPath", path: "relay", on: false });
  expect((await addresses(client)).rows.find((row) => row.path === "relay")?.on).toBe(false);
});

test("your own URL takes an https origin, is refused in words otherwise, and can be removed", async () => {
  const { client } = await connected();
  const custom = async () => (await addresses(client)).rows.find((row) => row.path === "custom");
  expect((await custom())?.ownUrl).toBeNull();
  expect(await outside(client, { op: "setPublicUrl", url: " https://ace.example.com " })).toEqual({
    ok: true,
  });
  expect((await custom())?.ownUrl).toBe("https://ace.example.com");
  expect(await outside(client, { op: "setPublicUrl", url: "http://ace.example.com/mcp" })).toEqual({
    ok: false,
    code: "invalid",
    message: "Use an https origin without a path, such as https://ace.example.com",
  });
  expect((await custom())?.ownUrl).toBe("https://ace.example.com");
  await outside(client, { op: "setPublicUrl", url: null });
  expect((await custom())?.ownUrl).toBeNull();
});

test("a phone that isn't the machine's administrator can't switch an address", async () => {
  const { client } = await connected(["read", "operate"]);
  expect(await outside(client, { op: "setPath", path: "relay", on: true })).toMatchObject({
    ok: false,
    message: "Only an administrator of studio can manage connected apps.",
  });
});
