import { expect, test } from "vitest";
import type { IngestProducer } from "./ingest-sources.ts";
import {
  accountBlockMs,
  MediaConnections,
  MediaIssue,
  type MediaOwner,
} from "./media-connections.ts";
import { MediaViewers, type ViewIntent } from "./media-viewers.ts";
import type { Revocation } from "./grants.ts";
import type { ToMedia } from "./wire.ts";

function harness(port = 41_000) {
  const sent: { message: ToMedia; payload: Uint8Array }[] = [];
  const revoked: Revocation[] = [];
  let now = 1_000_000;
  let ids = 0;
  let byte = 0;
  const connections = new MediaConnections({
    port: {
      send: (message, payload = new Uint8Array(0)) => {
        sent.push({ message, payload: payload.slice() });
        return true;
      },
      revoke: (message) => {
        revoked.push(message);
        return Promise.resolve("answered");
      },
      directPort: () => port,
      need: () => () => {},
      sleep: () => Promise.resolve(),
    },
    issue: new MediaIssue(),
    now: () => now,
    randomBytes: (length) => new Uint8Array(length).fill(++byte),
    id: () => `id-${++ids}`,
  });
  return {
    connections,
    sent,
    revoked,
    advance: (ms: number) => void (now += ms),
  };
}

const phone = (session: string, generation = 1): MediaOwner => ({
  session,
  device: "phone",
  admission: { kind: "pairing", generation },
});
const laptop: MediaOwner = {
  session: "laptop-session",
  device: "laptop",
  admission: { kind: "pairing", generation: 1 },
};

function granted(result: Awaited<ReturnType<MediaConnections["connect"]>>) {
  if (!result.ok) throw new Error(`refused: ${result.code}`);
  return result;
}

test("a connection's ticket goes to ace-media as the grant's payload, single use and 30 s long", async () => {
  const { connections, sent } = harness();
  const grant = granted(await connections.connect(phone("a")));
  expect(grant.url).toBe("ws://127.0.0.1:41000/media");
  expect(grant.expiresAt).toBe(1_000_000 + 30_000);
  const [ticket] = sent;
  expect(ticket?.message).toMatchObject({ type: "media.ticket", connection: grant.connection });
  expect(Buffer.from(ticket?.payload ?? []).toString("base64url")).toBe(grant.ticket);
  // Every connection gets its own id and ticket.
  const other = granted(await connections.connect(phone("a")));
  expect(other.connection).not.toBe(grant.connection);
  expect(other.ticket).not.toBe(grant.ticket);
});

test("no connection is made while ace-media isn't serving viewers", async () => {
  expect(await harness(0).connections.connect(phone("a"))).toMatchObject({
    ok: false,
    code: "unavailable",
  });
});

test("a subscribe binds a connection of its own session or of its device's own channel, and nothing else", async () => {
  const { connections, sent } = harness();
  const mine = granted(await connections.connect(phone("a")));
  const theirs = granted(await connections.connect(laptop));
  const view = {
    viewer: "v",
    source: "path-1",
    target: { kind: "browser", threadId: "t" } as const,
    codecs: ["avc1.42E033"],
    viewport: { width: 800, height: 600, dpr: 2, scale: 1 },
    local: true,
    audio: false,
  };
  // Another device's channel naming this device's connection.
  expect(connections.view({ ...laptop, session: "laptop-channel" }, mine.connection, view)).toBe(
    false,
  );
  // This device's session naming another device's connection.
  expect(connections.view(phone("a"), theirs.connection, view)).toBe(false);
  // The same device under another pairing (an older or newer credential), and under its account.
  expect(connections.view(phone("old-channel", 2), mine.connection, view)).toBe(false);
  const asAccount: MediaOwner = {
    session: "account-channel",
    device: "phone",
    admission: { kind: "account", account: "acct" },
  };
  expect(connections.view(asAccount, mine.connection, view)).toBe(false);
  expect(sent.filter((s) => s.message.type === "viewer.open")).toHaveLength(0);
  // Its own session, and a channel of the same device admitted the same way (iOS subscribes to
  // screens and devices on channels of their own).
  expect(connections.view(phone("a"), mine.connection, view)).toBe(true);
  expect(connections.view(phone("screen-channel"), mine.connection, view)).toBe(true);
  const opens = sent.filter((s) => s.message.type === "viewer.open").map((s) => s.message);
  // Both are granted under the connection's owner, which ace-media checks again.
  expect(opens).toHaveLength(2);
  for (const open of opens)
    expect(open).toMatchObject({ connection: mine.connection, owner: phone("a") });
});

test("every grant and revocation carries the next number of one issue sequence", async () => {
  const { connections, sent, revoked } = harness();
  const grant = granted(await connections.connect(phone("a")));
  connections.view(phone("a"), grant.connection, {
    viewer: "v",
    source: "p",
    target: { kind: "screen", sessionId: "s" },
    codecs: [],
    viewport: { width: 1, height: 1, dpr: 1, scale: 1 },
    local: false,
    audio: false,
  });
  void connections.revoke("phone");
  const issued = [
    ...sent.map((s) => ("issued" in s.message ? s.message.issued : -1)),
    ...revoked.map((r) => ("issued" in r ? r.issued : -1)),
  ];
  expect(issued).toEqual([1, 2, 3]);
});

test("a closed session closes its connections on the priority lane, and only its own", async () => {
  const { connections, revoked } = harness();
  const a = granted(await connections.connect(phone("a")));
  granted(await connections.connect(phone("b")));
  await connections.sessionClosed("a");
  expect(revoked).toEqual([
    { type: "connection.close", id: "id-1", connection: a.connection, reason: "session-closed" },
  ]);
  expect(connections.owned(phone("a"), a.connection)).toBeUndefined();
  expect([...connections.sessions()]).toEqual(["b"]);
});

test("after a revocation nothing more is minted for its owner, and a pairing's stays", async () => {
  const { connections, advance } = harness();
  const held = granted(await connections.connect(phone("a")));
  void connections.revoke("phone", { kind: "pairing", generation: 1 });
  expect(connections.owned(phone("a"), held.connection)).toBeUndefined();
  expect(await connections.connect(phone("a"))).toMatchObject({ ok: false, code: "refused" });
  advance(60_000);
  expect(await connections.connect(phone("a"))).toMatchObject({ ok: false, code: "refused" });
  // The device paired again: a new generation is a new credential.
  expect((await connections.connect(phone("c", 2))).ok).toBe(true);
});

test("a lapsed account admission blocks only until its sessions have closed", async () => {
  const { connections, advance } = harness();
  const account: MediaOwner = {
    session: "a",
    device: "phone",
    admission: { kind: "account", account: "acct" },
  };
  void connections.revoke("phone", { kind: "account", account: "acct" });
  expect((await connections.connect(account)).ok).toBe(false);
  // The pairing of the same device was never the account's.
  expect((await connections.connect(phone("p"))).ok).toBe(true);
  advance(accountBlockMs + 1);
  expect((await connections.connect({ ...account, session: "later" })).ok).toBe(true);
});

const producer = (threadId: string): IngestProducer => ({
  source: `capture-${threadId}`,
  kind: "tab",
  origin: { kind: "tab" },
  threadId,
  epoch: () => 0,
  consumers: { deliver: () => {}, record: () => {}, still: () => {}, end: () => {} },
  point: () => Promise.resolve(),
  keyframe: () => {},
});

test("a view follows its producer to each new id in ace-media and goes with its connection", async () => {
  const h = harness();
  const live: { producer: IngestProducer; path: string }[] = [];
  const viewers = new MediaViewers({
    connections: h.connections,
    live: () => live,
    send: (message) => {
      h.sent.push({ message, payload: new Uint8Array(0) });
      return true;
    },
    id: () => "poster-1",
    schedule: () => () => {},
    now: () => 0,
  });
  const grant = granted(await h.connections.connect(phone("a")));
  const tab = producer("t1");
  const intent: ViewIntent = {
    viewer: "v1",
    requester: phone("a"),
    connection: grant.connection,
    target: { kind: "browser", threadId: "t1" },
    codecs: ["avc1.42E033"],
    viewport: { width: 800, height: 600, dpr: 2, scale: 1 },
    local: true,
    audio: false,
    shows: (p) => p.threadId === "t1",
  };
  expect(viewers.bind({ ...intent, requester: laptop })).toBe(false);
  expect(viewers.bind(intent)).toBe(true);
  expect(viewers.granted("v1")).toBe(false); // nothing streams into ace-media yet
  viewers.live(producer("t2"), "other");
  viewers.live(tab, "path-1");
  viewers.live(tab, "path-2");
  const opens = h.sent.flatMap((s) => (s.message.type === "viewer.open" ? [s.message.source] : []));
  expect(opens).toEqual(["path-1", "path-2"]);
  viewers.received(
    { type: "connection.closed", connection: grant.connection, reason: "x" },
    new Uint8Array(0),
  );
  viewers.live(tab, "path-3");
  expect(h.sent.filter((s) => s.message.type === "viewer.open")).toHaveLength(2);
});

test("a connect starts ace-media, waits for its listener, and keeps it running while held", async () => {
  let needs = 0;
  let port: number | undefined;
  const connections = new MediaConnections({
    port: {
      send: () => true,
      revoke: () => Promise.resolve("answered"),
      directPort: () => port,
      need: () => {
        needs++;
        return () => void needs--;
      },
      // ace-media's listener comes up while the connect waits.
      sleep: () => {
        port = 41_001;
        return Promise.resolve();
      },
    },
    issue: new MediaIssue(),
    now: () => 0,
    randomBytes: (length) => new Uint8Array(length).fill(1),
    id: () => "id",
  });
  const grant = await connections.connect(phone("a"));
  expect(grant).toMatchObject({ ok: true, url: "ws://127.0.0.1:41001/media" });
  expect(needs).toBe(1);
  if (!grant.ok) return;
  connections.received({
    type: "connection.closed",
    connection: grant.connection,
    reason: "client-closed",
  });
  expect(needs).toBe(0);
});
