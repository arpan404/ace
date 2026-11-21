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
import { decodeToMedia, type FromMedia as FromMediaMessage, type ToMedia } from "./wire.ts";
import { LaneWriter } from "./lanes.ts";

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

/** A paired credential's generation as the daemon gives it: a hash, here of `n`. */
const credential = (n: number) => n.toString(16).padStart(32, "0");
const phone = (session: string, generation = 1): MediaOwner => ({
  session,
  device: "phone",
  admission: { kind: "pairing", generation: credential(generation) },
});
const laptop: MediaOwner = {
  session: "laptop-session",
  device: "laptop",
  admission: { kind: "pairing", generation: credential(1) },
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
  void connections.revoke("phone", { kind: "pairing", generation: credential(1) });
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
  consumers: { record: () => {}, still: () => {}, end: () => {} },
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
  const intent: Omit<ViewIntent, "viewer"> = {
    requester: phone("a"),
    connection: grant.connection,
    target: { kind: "browser", threadId: "t1" },
    codecs: ["avc1.42E033"],
    viewport: { width: 800, height: 600, dpr: 2, scale: 1 },
    local: true,
    audio: false,
    shows: (p) => p.threadId === "t1",
  };
  expect(viewers.bind({ ...intent, requester: laptop })).toBeUndefined();
  const v1 = viewers.bind(intent) ?? "";
  expect(v1).not.toBe("");
  expect(viewers.granted(v1)).toBe(false); // nothing streams into ace-media yet
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

test("a regrant opens a view ace-media replaced again, under its id, as last configured", async () => {
  const h = harness();
  const tab = producer("t1");
  const viewers = new MediaViewers({
    connections: h.connections,
    live: () => [{ producer: tab, path: "path-1" }],
    send: (message) => {
      h.sent.push({ message, payload: new Uint8Array(0) });
      return true;
    },
    id: () => "v",
    schedule: () => () => {},
    now: () => 0,
  });
  const grant = granted(await h.connections.connect(phone("a")));
  const viewer =
    viewers.bind({
      requester: phone("a"),
      connection: grant.connection,
      target: { kind: "browser", threadId: "t1" },
      codecs: ["avc1.42E033"],
      viewport: { width: 800, height: 600, dpr: 2, scale: 1 },
      local: true,
      audio: false,
      shows: (p) => p.threadId === "t1",
    }) ?? "";
  viewers.configure(viewer, { width: 400, height: 300, dpr: 2, scale: 1 }, true);
  viewers.regrant(viewer);
  const opens = h.sent.flatMap((s) => (s.message.type === "viewer.open" ? [s.message] : []));
  expect(opens.map((o) => o.viewer)).toEqual([viewer, viewer]);
  expect(opens[1]?.viewport.width).toBe(400);
  expect(opens[1]?.audio).toBe(true);
  // A fresh issue: ace-media takes it as a grant, not a replay.
  expect(opens[1]?.issued).toBeGreaterThan(opens[0]?.issued ?? Infinity);
  // A view no longer held is never opened again.
  viewers.unbind(viewer);
  viewers.regrant(viewer);
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

test("a ticket held behind backpressure reaches ace-media intact: the lane owns and wipes it", async () => {
  // The real lane writer, on a sink that is backpressured until after `connect` returns.
  const written: Uint8Array[] = [];
  const callbacks: (() => void)[] = [];
  let drain: (() => void) | undefined;
  let open = false;
  const sink = {
    write(chunk: Uint8Array, done: (error?: Error | null) => void) {
      written.push(chunk.slice());
      callbacks.push(() => done());
      return open;
    },
    onDrain(listener: () => void) {
      drain = listener;
    },
  };
  const lane = new LaneWriter("normal", sink, () => {});
  // Something big ahead of the ticket fills the sink.
  lane.send({ type: "ping", id: "first" });
  let payload: Uint8Array | undefined;
  const connections = new MediaConnections({
    port: {
      send: (message, bytes = new Uint8Array(0)) => {
        payload = bytes;
        lane.send(message, bytes);
        return true;
      },
      revoke: () => Promise.resolve("answered"),
      directPort: () => 41_000,
      need: () => () => {},
      sleep: () => Promise.resolve(),
    },
    issue: new MediaIssue(),
    now: () => 0,
    randomBytes: (length) => new Uint8Array(length).map((_, i) => i + 1),
    id: () => "id",
  });
  const grant = granted(await connections.connect(phone("a")));
  expect(written).toHaveLength(1); // only the ping: the ticket waits behind it
  open = true;
  drain?.();
  for (const callback of callbacks.splice(0)) callback();
  const frame = new Uint8Array(written.slice(1).reduce((n, chunk) => n + chunk.length, 0));
  let at = 0;
  for (const chunk of written.slice(1)) frame.set(chunk, (at += chunk.length) - chunk.length);
  const decoded = decodeToMedia(frame, "normal");
  expect(decoded.message.type).toBe("media.ticket");
  expect(Buffer.from(decoded.payload).toString("base64url")).toBe(grant.ticket);
  // Once written, the lane wipes its copy.
  expect(payload?.every((byte) => byte === 0)).toBe(true);
});

test("a poster asks only for the epochs its producer vouches were clear, and a private answer is no poster", async () => {
  const h = harness();
  const live: { producer: IngestProducer; path: string }[] = [];
  const asked: ToMedia[] = [];
  let answer: ((message: FromMediaMessage) => void) | undefined;
  const viewers = new MediaViewers({
    connections: h.connections,
    live: () => live,
    send: (message) => {
      asked.push(message);
      if (message.type === "still.poster")
        queueMicrotask(() =>
          answer?.({ type: "still.failed", request: message.request, reason: "private" }),
        );
      return true;
    },
    id: () => "poster-1",
    schedule: () => () => {},
    now: () => 0,
  });
  answer = (message) => viewers.received(message, new Uint8Array(0));
  const grant = granted(await h.connections.connect(phone("a")));
  const vouching = { ...producer("t1"), clearEpochs: () => [[0, 4]] as [number, number][] };
  live.push({ producer: vouching, path: "path-1" });
  const intent: Omit<ViewIntent, "viewer"> = {
    requester: phone("a"),
    connection: grant.connection,
    target: { kind: "browser", threadId: "t1" },
    codecs: ["avc1.42E033"],
    viewport: { width: 400, height: 300, dpr: 2, scale: 1 },
    local: true,
    audio: false,
    shows: (p) => p.threadId === "t1",
  };
  const v1 = viewers.bind(intent) ?? "";
  expect(await viewers.poster(v1)).toBeUndefined();
  expect(asked.find((m) => m.type === "still.poster")).toMatchObject({ clear: [[0, 4]] });
  // A producer that says nothing about its epochs vouches for none.
  asked.length = 0;
  live[0] = { producer: producer("t1"), path: "path-2" };
  viewers.live(live[0].producer, "path-2");
  await viewers.poster(v1);
  expect(asked.find((m) => m.type === "still.poster")).toMatchObject({ clear: [] });
});

test("a view's grant is closed when its producer leaves ace-media, and again on unbind only if open", async () => {
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
  live.push({ producer: tab, path: "path-1" });
  const v1 =
    viewers.bind({
      requester: phone("a"),
      connection: grant.connection,
      target: { kind: "browser", threadId: "t1" },
      codecs: ["avc1.42E033"],
      viewport: { width: 800, height: 600, dpr: 2, scale: 1 },
      local: true,
      audio: false,
      shows: (p) => p.threadId === "t1",
    }) ?? "";
  const closes = () => h.sent.filter((s) => s.message.type === "viewer.close").length;
  // The route moved the producer back to the daemon: ace-media's view must go with it.
  viewers.live(tab, undefined);
  expect(closes()).toBe(1);
  expect(viewers.granted(v1)).toBe(false);
  // Unbinding now closes nothing more: that grant is already gone.
  viewers.unbind(v1);
  expect(closes()).toBe(1);
});
