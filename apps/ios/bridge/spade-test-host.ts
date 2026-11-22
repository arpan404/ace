import { createHash } from "node:crypto";
import { afterEach } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, FakeSpadeApi, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { until } from "./test-host.ts";
import { NativeSpade } from "./spade.ts";
import { ImageBudget, imageBudgetBytes } from "./image-budget.ts";
import { answerSpade, type NativeSpadeRequest } from "./spade-requests.ts";
import type { SpadeBubbleRow, SpadeListRow } from "./spade-rows.ts";
import type { Picked } from "./thread-attachments.ts";
import type { SpadeHostingWire } from "./spade-hosting.ts";
import type { SpadeKeep } from "./spade-kept-events.ts";

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
          host?: string | null;
          main?: SpadeHostingWire;
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
  seed: (spade: FakeSpadeApi, daemon: FakeDaemon) => void = () => {},
  wait: typeof later = later,
  phone: {
    /** The phone's snapshot store, which outlives one runtime (`memoryKeep`). */
    keep?: SpadeKeep;
    /** Where the runtime keeps what the next launch draws first. */
    checkpoint?: (json: string) => void;
  } = {},
) {
  const daemon = new FakeDaemon({ clock: Date.now, hostId: "ios-test-host", token: "t" });
  daemon.services.settings.write("beta.spade", true);
  daemon.services.settings.write("spade.enabled", true);
  daemon.spade.status = { state: "ready", version: "0.6.0" };
  const api = new FakeSpadeApi(daemon.spade, () => Date.now());
  seed(api, daemon);
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
    ...phone,
  });
  stops.push(() => spade.stop());
  spade.start();
  // What Swift has staged (`AttachmentStaging`), read back a chunk at a time as Swift answers.
  const staged = new Map<string, Uint8Array>();
  const chunks = async (localId: string, offset: number, limit: number) => {
    const bytes = staged.get(localId);
    if (!bytes) throw new Error("Attachment unavailable");
    return Buffer.from(bytes.subarray(offset, offset + limit)).toString("base64");
  };
  const stage = (name: string, mimeType: string, bytes: Uint8Array): Picked => {
    const localId = crypto.randomUUID();
    staged.set(localId, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return { localId, name, mimeType, bytes: bytes.length, sha256 };
  };
  const ask = (request: NativeSpadeRequest) =>
    answerSpade(
      owner,
      spade,
      request,
      {
        id: () => crypto.randomUUID(),
        now: () => Date.now(),
        images: new ImageBudget(imageBudgetBytes),
        chunks,
      },
      new AbortController().signal,
    );
  return { daemon, api, spade, patches, ask, stage, staged };
}

/** The phone's snapshot store in memory, as JSON, so one launch's runtime leaves it to the next. */
export function memoryKeep(): SpadeKeep & { held: Map<string, string> } {
  const held = new Map<string, string>();
  return {
    held,
    get: async (key) => {
      const text = held.get(key);
      return text === undefined ? undefined : (JSON.parse(text) as unknown);
    },
    set: async (key, value) => void held.set(key, JSON.stringify(value)),
  };
}

/** A hundred times faster than the phone's clock: the away pace is seconds, not milliseconds. */
export function quick(delay: number, callback: () => void) {
  return later(delay / 100, callback);
}

export function later(delay: number, callback: () => void) {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
}
