import { afterEach } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, FakeSpadeApi, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { until } from "./test-host.ts";
import { NativeSpade } from "./spade.ts";
import { answerSpade, type NativeSpadeRequest } from "./spade-requests.ts";
import type { SpadeBubbleRow, SpadeListRow } from "./spade-rows.ts";

/*
 * Spade's bridge over the real SDK and an in-process fake daemon with a fake Spade behind
 * `spade.*`, for the Spade tests: what Swift holds of it, and the requests it answers.
 */

const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).toReversed()) await stop();
});

/** What Swift holds: each key's latest patch. */
export class Patches {
  readonly held = new Map<string, Record<string, unknown>>();
  put(key: string, read: () => Record<string, unknown> | undefined) {
    const value = read();
    if (value) this.held.set(key, value);
    else this.held.delete(key);
  }
  clear(prefix: string) {
    for (const key of this.held.keys()) if (key.startsWith(prefix)) this.held.delete(key);
  }
  get state() {
    return this.held.get("spade:state") as
      | {
          shown: boolean | null;
          line: { sentence: string; ready: boolean; canTurnOn: boolean };
          list: { rows: SpadeListRow[] | null; failed: boolean };
        }
      | undefined;
  }
  /** The open conversation's bubbles, in their order. */
  get bubbles(): SpadeBubbleRow[] {
    const order = (this.held.get("spade:order")?.order ?? []) as string[];
    return order.flatMap((key) => {
      const row = this.held.get(`spade:row:${key}`)?.row;
      return row ? [row as SpadeBubbleRow] : [];
    });
  }
  get head() {
    return this.held.get("spade:conversation");
  }
}

export async function setUp(
  seed: (spade: FakeSpadeApi) => void = () => {},
  wait: typeof later = later,
) {
  const daemon = new FakeDaemon({ clock: Date.now, hostId: "ios-test-host", token: "t" });
  daemon.services.settings.write("beta.spade", true);
  daemon.services.settings.write("spade.enabled", true);
  daemon.spade.status = { state: "ready", version: "0.6.0" };
  const api = new FakeSpadeApi(daemon.spade, () => Date.now());
  seed(api);
  const owner = new ClientCore({
    deviceId: DeviceId.parse("ios-spade-test"),
    expectedHostId: HostId.parse("ios-test-host"),
    transport: () => fakeTransport(daemon),
    credential: async () => ({ token: "t" }),
    storage: { load: async () => null, save: async () => {} },
    scheduler: { set: later },
    id: () => crypto.randomUUID(),
    random: () => 0.5,
    now: () => Date.now(),
  });
  stops.push(() => owner.close());
  await owner.start();
  await until(() => owner.state === "ready");
  const patches = new Patches();
  const spade = new NativeSpade(owner, patches, {
    now: () => Date.now(),
    id: () => crypto.randomUUID(),
    later: wait,
  });
  stops.push(() => spade.stop());
  spade.start();
  const ask = (request: NativeSpadeRequest) =>
    answerSpade(
      owner,
      spade,
      request,
      { id: () => crypto.randomUUID(), now: () => Date.now() },
      new AbortController().signal,
    );
  return { daemon, api, spade, patches, ask };
}

/** A hundred times faster than the phone's clock: the away pace is seconds, not milliseconds. */
export function quick(delay: number, callback: () => void) {
  return later(delay / 100, callback);
}

export function later(delay: number, callback: () => void) {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
}
