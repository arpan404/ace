import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { HostChannel } from "@ace/relay";
import { RemoteAuth } from "../remote-auth.ts";
import { Store } from "../store.ts";
import { NkAdmission } from "./admission.ts";
import { nkHost, type EarlyMain } from "./host.ts";

// The daemon admitting NK first messages (ADR 0155, step 2) when every one of them is valid:
// fresh grant-bearing attempts, each with its own ephemeral key, can't hold more than the
// limits allow, and confirmed sessions are unaffected.

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function setup() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "ace-nk-host-")), "events.sqlite"));
  stores.push(store);
  let now = 1_000_000;
  const timers: { at: number; run: () => void }[] = [];
  const clock = {
    now: () => now,
    schedule(ms: number, run: () => void) {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return () => {
        const at = timers.indexOf(timer);
        if (at >= 0) timers.splice(at, 1);
      };
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const timer of timers.filter((t) => t.at <= now)) {
      timers.splice(timers.indexOf(timer), 1);
      timer.run();
    }
  };
  const auth = new RemoteAuth(store.devices, "a".repeat(64), {
    now: () => now,
    secret: randomUUID,
  });
  const admission = new NkAdmission(clock);
  let grantChecks = 0;
  // The account boundary: every grant checks out, as a stolen or replayed fresh grant would.
  let keyCached = true;
  const account = {
    // The network check: an NK first message must never wait on it.
    admitDevice: () => new Promise<never>(() => {}),
    async admitDeviceCached() {
      grantChecks++;
      return keyCached
        ? { admitted: true as const, account: "user_a", expiresAt: now + 300_000 }
        : { admitted: false as const, code: "unauthorized" as const, message: "" };
    },
    stillAdmitted: () => true,
    status: () => ({ machineCode: {} }) as never,
  };
  const served: EarlyMain[] = [];
  const host = nkHost({
    admission,
    epoch: "relay-key",
    auth,
    devices: store.devices,
    account,
    serve: (entry) => {
      served.push(entry);
    },
  });
  return {
    host,
    admission,
    advance,
    served,
    grantChecks: () => grantChecks,
    uncache: () => (keyCached = false),
  };
}

const early = (device: string) =>
  new TextEncoder().encode(
    JSON.stringify({ type: "hello.early", protocolVersion: 1, deviceId: device, grant: "grant" }),
  );
let keys = 0;
const ephemeral = () =>
  new Uint8Array(32).fill(++keys % 256).map((b, i) => (i === 1 ? keys >> 8 : b));

/** A channel that never confirms until `confirm` is called. */
function channel() {
  let deliver: ((text: string) => void) | undefined;
  let close: (() => void) | undefined;
  const closed = new Promise<undefined>((resolve) => (close = () => resolve(undefined)));
  const opened = {
    receiveRaw: () => new Promise<string>((resolve) => (deliver = resolve)),
    authorize() {},
    close: () => close?.(),
    closed,
  } as unknown as HostChannel;
  return { opened, confirm: () => deliver?.('{"type":"hello.confirm"}'), closed };
}

it("a flood of valid-grant first messages for one device opens at most 2 unconfirmed sessions and checks at most 4 grants", async () => {
  const s = setup();
  const results = [];
  for (let n = 0; n < 40; n++) {
    if (!s.host.arrive()) break;
    results.push(await s.host.admit(early("phone"), ephemeral()));
  }
  // The device's rate (burst 4) stops the flood before its grant is checked; 2 sessions open.
  expect(s.grantChecks()).toBe(4);
  expect(results.filter(Boolean)).toHaveLength(2);
  expect(s.admission.held().sessions).toBe(2);
});

it("a flood across many devices holds at most 32 unconfirmed sessions, and all of them go at the deadline", async () => {
  const s = setup();
  const opened = [];
  for (let n = 0; n < 40; n++) {
    if (!s.host.arrive()) break;
    const accepted = await s.host.admit(early(`device-${n}`), ephemeral());
    if (accepted) {
      const each = channel();
      await accepted.open(each.opened);
      opened.push(each);
    }
  }
  expect(opened).toHaveLength(32);
  expect(s.admission.held().sessions).toBe(32);
  // A confirmed session isn't touched by the flood or the deadline.
  opened[0]?.confirm();
  await s.served[0]?.confirmed;
  expect(s.admission.held().sessions).toBe(31);
  s.advance(5_000);
  await Promise.all(opened.slice(1).map((each) => each.closed));
  expect(s.admission.held()).toMatchObject({ sessions: 0, bytes: 0 });
  expect(await s.served[0]?.confirmed).toEqual({ type: "hello.confirm" });
  // And the daemon takes new ones again.
  s.advance(2_000);
  expect(await s.host.admit(early("device-new"), ephemeral())).toBeDefined();
});

it("the daemon decrypts at most its burst of first messages before any credential work", async () => {
  const s = setup();
  let arrived = 0;
  for (let n = 0; n < 100; n++) if (s.host.arrive()) arrived++;
  expect(arrived).toBe(40);
});

it("a grant whose key isn't cached is refused at once, without waiting on the network", async () => {
  const s = setup();
  s.uncache();
  expect(await s.host.admit(early("phone"), ephemeral())).toBeUndefined();
  expect(s.admission.held()).toMatchObject({ sessions: 0, suppressed: 0 });
});

it("an admission the relay abandons as late gives its session back at once", async () => {
  const s = setup();
  const accepted = await s.host.admit(early("phone"), ephemeral());
  expect(s.admission.held().sessions).toBe(1);
  accepted?.abandon();
  expect(s.admission.held()).toMatchObject({ sessions: 0, bytes: 0 });
});
