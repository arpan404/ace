import { expect, test } from "vitest";
import type { MachinePathKind } from "@ace/protocol";
import { racingTransport, type MachineRoute } from "./path-race.ts";
import { ManualScheduler } from "./test-support.ts";
import type { Transport, TransportEvents } from "./types.ts";

/** A path whose socket the test opens or fails by hand. */
function fakePath(kind: MachinePathKind) {
  const state = { started: 0, closed: false, events: undefined as TransportEvents | undefined };
  const route: MachineRoute = {
    path: { key: kind, kind },
    credential: async () => "token",
    transport: (): Transport => ({
      open(events) {
        state.started++;
        state.events = events;
      },
      send() {},
      close() {
        state.closed = true;
      },
    }),
  };
  return {
    route,
    state,
    open: () => state.events?.open(),
    fail: () => state.events?.close(1006, "refused"),
    refuse: (code: number, reason: string) => state.events?.close(code, reason),
  };
}

function race(...paths: ReturnType<typeof fakePath>[]) {
  const scheduler = new ManualScheduler();
  const outcome = {
    won: "",
    failed: [] as string[],
    opened: false,
    closed: undefined as number | undefined,
    reason: undefined as string | undefined,
  };
  const transport = racingTransport({
    routes: paths.map((path) => path.route),
    scheduler,
    won: (route) => (outcome.won = route.path.key),
    failed: (route) => outcome.failed.push(route.path.key),
  });
  transport.open({
    open: () => (outcome.opened = true),
    message: () => {},
    close: (code, reason) => {
      outcome.closed = code;
      outcome.reason = reason;
    },
  });
  return { scheduler, outcome };
}

test("each next path starts 150 ms after the previous one, and the first to open wins", () => {
  const lan = fakePath("lan");
  const relay = fakePath("relay");
  const { scheduler, outcome } = race(lan, relay);
  expect([lan.state.started, relay.state.started]).toEqual([1, 0]);
  scheduler.advance(149);
  expect(relay.state.started).toBe(0);
  scheduler.advance(1);
  expect(relay.state.started).toBe(1);
  relay.open();
  expect(outcome).toMatchObject({ won: "relay", opened: true });
  // The slower path closes; the winner stays open.
  expect([lan.state.closed, relay.state.closed]).toEqual([true, false]);
});

test("a path that fails fast lets the next start at once", () => {
  const lan = fakePath("lan");
  const relay = fakePath("relay");
  const { outcome } = race(lan, relay);
  lan.fail();
  expect(relay.state.started).toBe(1);
  expect(outcome.failed).toEqual(["lan"]);
});

test("a winner stops the race: later paths never start", () => {
  const lan = fakePath("lan");
  const relay = fakePath("relay");
  const { scheduler, outcome } = race(lan, relay);
  lan.open();
  scheduler.advance(1_000);
  expect(relay.state.started).toBe(0);
  expect(outcome.won).toBe("lan");
});

test("when every path fails the attempt closes as a drop, once", () => {
  const lan = fakePath("lan");
  const relay = fakePath("relay");
  const { outcome } = race(lan, relay);
  lan.fail();
  relay.fail();
  expect(outcome).toMatchObject({ opened: false, closed: 1006, failed: ["lan", "relay"] });
});

test("one path dropping and another refused closes as a drop that says why, so it retries", () => {
  const lan = fakePath("lan");
  const relay = fakePath("relay");
  const { scheduler, outcome } = race(lan, relay);
  scheduler.advance(150);
  // Away from home: the direct path is out and the relay finds the machine on another account.
  relay.refuse(4403, "Not your machine");
  expect(outcome.closed).toBeUndefined();
  lan.fail();
  expect(outcome).toMatchObject({ opened: false, closed: 1006, reason: "Not your machine" });
});

test("when every path is refused the attempt closes with a refusal, not as a drop", () => {
  const lan = fakePath("lan");
  const relay = fakePath("relay");
  const { scheduler, outcome } = race(lan, relay);
  scheduler.advance(150);
  relay.refuse(4403, "Not your machine");
  lan.refuse(4001, "Credential refused");
  expect(outcome).toMatchObject({ opened: false, closed: 4001, reason: "Credential refused" });
});

test("the owner's revocation heard on one path ends the attempt even when another path dropped", () => {
  const lan = fakePath("lan");
  const relay = fakePath("relay");
  const { scheduler, outcome } = race(lan, relay);
  scheduler.advance(150);
  lan.refuse(4003, "Device revoked");
  relay.fail();
  expect(outcome).toMatchObject({ opened: false, closed: 4003, reason: "Device revoked" });
});

test("a refused path does not end the attempt while another path can still win", () => {
  const lan = fakePath("lan");
  const relay = fakePath("relay");
  const { outcome } = race(lan, relay);
  lan.refuse(4003, "Device revoked");
  relay.open();
  expect(outcome).toMatchObject({ won: "relay", opened: true, closed: undefined });
});

test("a machine with no usable path closes at once", () => {
  expect(race().outcome.closed).toBe(1006);
});
