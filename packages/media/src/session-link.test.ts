import { expect, test } from "vitest";
import { pumpSessionLinks, SessionLinks } from "@ace/media/session-link";
import { ToMedia, type FromMedia } from "@ace/media/wire";

const owner = (session: string) => ({
  session,
  device: `device-${session}`,
  admission: { kind: "pairing" as const, generation: 1 },
});
const opened = (connection: string, session: string): FromMedia => ({
  type: "connection.open",
  connection,
  kind: "relay",
  owner: owner(session),
});
const closed = (connection: string): FromMedia => ({
  type: "connection.closed",
  connection,
  reason: "gone",
});

/** A clock the test moves by hand, firing timers that fall due. */
function manualClock() {
  let now = 0;
  let timers: { at: number; run: () => void }[] = [];
  return {
    clock: {
      now: () => now,
      setTimeout(run: () => void, ms: number) {
        const timer = { at: now + ms, run };
        timers.push(timer);
        return () => void (timers = timers.filter((other) => other !== timer));
      },
    },
    advance(ms: number) {
      for (const until = now + ms; now < until;) {
        now++;
        const due = timers.filter((timer) => timer.at <= now);
        timers = timers.filter((timer) => timer.at > now);
        for (const timer of due) timer.run();
      }
    },
  };
}

test("a main session is signalled every 500 ms only while it has a media connection", () => {
  const links = new SessionLinks();
  const time = manualClock();
  const sent: ToMedia[] = [];
  const stop = pumpSessionLinks(links, time.clock, (message) => void sent.push(message));
  links.sample("phone", 400, 2_000);
  time.advance(1_000);
  expect(sent).toEqual([]);
  links.received(opened("c1", "phone"));
  time.advance(1_000);
  expect(sent).toEqual([
    { type: "session.link", session: "phone", rttMs: 400, backlogBytes: 2_000 },
    { type: "session.link", session: "phone", rttMs: 400, backlogBytes: 2_000 },
  ]);
  links.received(closed("c1"));
  time.advance(1_000);
  expect(sent.length).toBe(2);
  links.received(opened("c2", "phone"));
  stop();
  time.advance(1_000);
  expect(sent.length).toBe(2);
});

test("the round trip is smoothed and the backlog is the latest, one signal per session", () => {
  const links = new SessionLinks();
  links.received(opened("c1", "phone"));
  links.received(opened("c2", "phone"));
  links.received(opened("c3", "laptop"));
  links.sample("phone", 400, 10_000);
  links.sample("phone", 1_200, 50_000);
  links.sample("laptop", 30, 0);
  expect(links.signals()).toEqual([
    { type: "session.link", session: "phone", rttMs: 500, backlogBytes: 50_000 },
    { type: "session.link", session: "laptop", rttMs: 30, backlogBytes: 0 },
  ]);
  // One of the phone's two media connections closing leaves it signalled.
  links.received(closed("c1"));
  expect(links.signals().map((signal) => signal.session)).toEqual(["phone", "laptop"]);
});

test("a session with no round trip yet, an ended session, or a restarted ace-media says nothing", () => {
  const links = new SessionLinks();
  links.received(opened("c1", "phone"));
  links.received(opened("c2", "laptop"));
  expect(links.signals()).toEqual([]);
  links.sample("phone", 300, 0);
  links.sample("laptop", 20, 0);
  links.ended("laptop");
  expect(links.signals().map((signal) => signal.session)).toEqual(["phone"]);
  links.restarted();
  expect(links.signals()).toEqual([]);
  // The round trip survives the restart: the session's next media connection is signalled at once.
  links.received(opened("c3", "phone"));
  expect(links.signals()).toEqual([
    { type: "session.link", session: "phone", rttMs: 300, backlogBytes: 0 },
  ]);
});

test("every signal is a valid wire message, whatever the samples were", () => {
  const links = new SessionLinks();
  links.received(opened("c1", "phone"));
  links.sample("phone", Number.NaN, 1);
  links.sample("phone", -5, 1);
  expect(links.signals()).toEqual([]);
  links.sample("phone", 1e12, Number.POSITIVE_INFINITY);
  links.sample("phone", 0.4, -3);
  for (const signal of links.signals()) expect(ToMedia.parse(signal)).toEqual(signal);
});
