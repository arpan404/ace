import { expect, it, vi } from "vitest";
import type { TransportEvents } from "@ace/client";
import {
  base64ToBytes,
  bridgePinnedHttp,
  bridgeSocketTransport,
  expoBridgeFromModule,
  ticketFetch,
  type ExpoPinnedBridge,
  type ExpoSocketEvent,
} from "./expo-bridge.ts";
import { TrustMonitor } from "./pinned-transport.ts";

const PIN = "9f".repeat(32);
const TOKEN = "e0".repeat(32);
const ORIGIN = "https://192.168.1.20:4243/";
const SOCKET_URL = "wss://192.168.1.20:4243/";

function fakeBridge(): ExpoPinnedBridge & {
  listeners: ((event: ExpoSocketEvent) => void)[];
  opened: { id: string; url: string; fingerprint: string }[];
  sent: { id: string; text: string }[];
  closed: string[];
  emit(event: ExpoSocketEvent): void;
} {
  const listeners: ((event: ExpoSocketEvent) => void)[] = [];
  const opened: { id: string; url: string; fingerprint: string }[] = [];
  const sent: { id: string; text: string }[] = [];
  const closed: string[] = [];
  return {
    listeners,
    opened,
    sent,
    closed,
    pinnedFetch: async () => ({ status: 200, body: "{}" }),
    pinnedSocketOpen: (id, url, fingerprint) => {
      opened.push({ id, url, fingerprint });
    },
    pinnedSocketSend: (id, text) => {
      sent.push({ id, text });
    },
    pinnedSocketClose: (id) => {
      closed.push(id);
    },
    addSocketListener: (listener) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    emit: (event) => {
      for (const listener of listeners.slice()) listener(event);
    },
  };
}

function events(): TransportEvents & {
  opened: number;
  messages: string[];
  binaries: Uint8Array[];
  closes: { code: number; reason: string | undefined }[];
} {
  const record = {
    opened: 0,
    messages: [] as string[],
    binaries: [] as Uint8Array[],
    closes: [] as { code: number; reason: string | undefined }[],
  };
  return {
    ...record,
    open: () => {
      record.opened += 1;
    },
    message: (text: string) => {
      record.messages.push(text);
    },
    binary: (bytes: Uint8Array) => {
      record.binaries.push(bytes);
    },
    close: (code: number, reason?: string) => {
      record.closes.push({ code, reason });
    },
  };
}

it("rejects a mis-registered native module before any credential is touched", () => {
  for (const bad of [undefined, null, {}, { pinnedFetch: async () => ({}) }]) {
    expect(() => expoBridgeFromModule(bad)).toThrow();
  }
  const bridge = fakeBridge();
  expect(expoBridgeFromModule(bridge)).toBe(bridge);
});

it("sends pinned HTTPS through the bridge with the confirmed pin", async () => {
  const bridge = fakeBridge();
  let seen: unknown;
  bridge.pinnedFetch = async (input) => {
    seen = input;
    return { status: 200, body: '{"ticket":"t"}' };
  };
  const http = bridgePinnedHttp(bridge, { origin: ORIGIN, fingerprint: PIN });
  const response = await http({ method: "POST", path: "/v1/tickets", token: TOKEN });
  expect(response).toEqual({ status: 200, body: '{"ticket":"t"}' });
  expect(seen).toMatchObject({ origin: ORIGIN, fingerprint: PIN, method: "POST" });
});

it("refuses to send when the pin is malformed without touching the bridge", async () => {
  const bridge = fakeBridge();
  const send = vi.spyOn(bridge, "pinnedFetch");
  expect(() => bridgePinnedHttp(bridge, { origin: ORIGIN, fingerprint: "bad" })).toThrow();
  const http = bridgePinnedHttp(bridge, { origin: ORIGIN, fingerprint: PIN });
  await expect(
    http({ method: "POST", path: "/v1/tickets", token: "bad-token" }),
  ).rejects.toMatchObject({ refusal: "invalid" });
  expect(send).not.toHaveBeenCalled();
});

it("adapts pinned HTTPS to the ticket exchange fetch shape", async () => {
  const bridge = fakeBridge();
  const http = bridgePinnedHttp(bridge, { origin: ORIGIN, fingerprint: PIN });
  const fetch = ticketFetch(http);
  const response = await fetch(`${ORIGIN}v1/tickets`, {
    method: "POST",
    redirect: "error",
    credentials: "omit",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(undefined),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({});
});

it("reports a ticket pin refusal to trust as a 401 instead of offline", async () => {
  const { PinnedTransportError } = await import("./pinned-transport.ts");
  const failing = async () => {
    throw new PinnedTransportError("pin");
  };
  const trust = new TrustMonitor();
  const fetch = ticketFetch(failing as never, { trust });
  const response = await fetch(`${ORIGIN}v1/tickets`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: "{}",
  });
  expect(response.status).toBe(401);
  expect(trust.failure).toBe("pin");
});

it("never clears a pin failure on ticket success (ts.net cannot prove the pin)", async () => {
  const bridge = fakeBridge();
  const http = bridgePinnedHttp(bridge, { origin: ORIGIN, fingerprint: PIN });
  const trust = new TrustMonitor();
  trust.report("pin");
  const fetch = ticketFetch(http, { trust });
  const response = await fetch(`${ORIGIN}v1/tickets`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: "{}",
  });
  expect(response.status).toBe(200);
  // A 200 may have ridden the ADR 0097 `*.ts.net` system-trust fallback with
  // a still-wrong pin, and this bridge reports no which-path signal: the
  // mismatch stays until the binding changes.
  expect(trust.failure).toBe("pin");
});

it("never clears a pin failure on a late ticket success after abort", async () => {
  let release!: (value: { status: number; body: string }) => void;
  const hanging = new Promise<{ status: number; body: string }>((resolve) => {
    release = resolve;
  });
  const trust = new TrustMonitor();
  trust.report("pin");
  const fetch = ticketFetch(() => hanging as never, { trust });
  const controller = new AbortController();
  const pending = fetch(`${ORIGIN}v1/tickets`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: "{}",
    signal: controller.signal,
  });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  // The native request still completes late (the bridge cannot cancel it):
  // that late success must not clear the failure it outlived.
  release({ status: 200, body: "{}" });
  await hanging;
  for (let flush = 0; flush < 10; flush++) await Promise.resolve();
  expect(trust.failure).toBe("pin");
});

it("leaves a pin failure untouched when the ticket fetch aborts", async () => {
  let resolved = false;
  const hanging = new Promise<{ status: number; body: string }>((resolve) => {
    setTimeout(() => {
      resolved = true;
      resolve({ status: 200, body: "{}" });
    }, 5000);
  });
  const trust = new TrustMonitor();
  trust.report("pin");
  const fetch = ticketFetch(() => hanging as never, { trust });
  const controller = new AbortController();
  const pending = fetch(`${ORIGIN}v1/tickets`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: "{}",
    signal: controller.signal,
  });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(resolved).toBe(false);
  // An abort neither reports nor clears: the previous failure still stands
  // until a fresh binding replaces it (success can never clear it either).
  expect(trust.failure).toBe("pin");
});

it("stops waiting when the ticket fetch aborts without reporting trust", async () => {
  let resolved = false;
  const hanging = new Promise<{ status: number; body: string }>((resolve) => {
    setTimeout(() => {
      resolved = true;
      resolve({ status: 200, body: "{}" });
    }, 5000);
  });
  const trust = new TrustMonitor();
  const fetch = ticketFetch(() => hanging as never, { trust });
  const controller = new AbortController();
  const pending = fetch(`${ORIGIN}v1/tickets`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: "{}",
    signal: controller.signal,
  });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(resolved).toBe(false);
  expect(trust.failure).toBeUndefined();
});

it("delivers only its own socket id and unsubscribes on close", () => {
  const bridge = fakeBridge();
  let next = 0;
  const first = events();
  const second = events();
  const one = bridgeSocketTransport(bridge, {
    url: SOCKET_URL,
    fingerprint: PIN,
    id: () => `socket-${(next += 1)}`,
  });
  const two = bridgeSocketTransport(bridge, {
    url: SOCKET_URL,
    fingerprint: PIN,
    id: () => `socket-${(next += 1)}`,
  });
  one.open(first);
  two.open(second);
  expect(bridge.opened.map((entry) => entry.id)).toEqual(["socket-1", "socket-2"]);

  bridge.emit({ id: "socket-1", type: "message", value: "hello" });
  expect(first.messages).toEqual(["hello"]);
  expect(second.messages).toEqual([]);

  one.close();
  bridge.emit({ id: "socket-1", type: "message", value: "late" });
  expect(first.messages).toEqual(["hello"]);
  bridge.emit({ id: "socket-2", type: "message", value: "world" });
  expect(second.messages).toEqual(["world"]);
  expect(bridge.closed).toEqual(["socket-1"]);
});

it("routes trust reports beside the fatal close without delivering frames after it", () => {
  const bridge = fakeBridge();
  const trust = new TrustMonitor();
  const seen = events();
  const transport = bridgeSocketTransport(bridge, {
    url: SOCKET_URL,
    fingerprint: PIN,
    id: () => "socket-1",
    trust,
  });
  transport.open(seen);
  bridge.emit({ id: "socket-1", type: "trust", value: "pin" });
  expect(trust.failure).toBe("pin");
  bridge.emit({ id: "socket-1", type: "close", value: "4003" });
  expect(seen.closes).toEqual([{ code: 4003, reason: undefined }]);
  bridge.emit({ id: "socket-1", type: "message", value: "late" });
  expect(seen.messages).toEqual([]);
});

it("never clears a pin failure when the socket opens (open cannot prove the pin)", () => {
  const bridge = fakeBridge();
  const trust = new TrustMonitor();
  trust.report("pin");
  let opened = 0;
  const seen: TransportEvents = {
    open: () => {
      opened += 1;
    },
    message: () => {},
    close: () => {},
  };
  const transport = bridgeSocketTransport(bridge, {
    url: SOCKET_URL,
    fingerprint: PIN,
    id: () => "socket-1",
    trust,
  });
  transport.open(seen);
  expect(trust.failure).toBe("pin");
  // On a `*.ts.net` host the native layer may open on Tailscale system trust
  // with a mismatched pin (ADR 0097): `open` is not pin proof, so the earlier
  // failure stands and the frames still flow to their owner.
  bridge.emit({ id: "socket-1", type: "open", value: "" });
  expect(trust.failure).toBe("pin");
  expect(opened).toBe(1);
});

it("never lets a stale socket touch the replacement's trust or frames", () => {
  const bridge = fakeBridge();
  const oldTrust = new TrustMonitor();
  let opened = 0;
  const seen: TransportEvents = {
    open: () => {
      opened += 1;
    },
    message: () => {},
    close: () => {},
  };
  let current = true;
  const transport = bridgeSocketTransport(bridge, {
    url: SOCKET_URL,
    fingerprint: PIN,
    id: () => "socket-1",
    trust: oldTrust,
    isCurrent: () => current,
  });
  transport.open(seen);
  // The runtime was replaced before its socket opened: the late open must
  // neither touch trust nor deliver frames to the new owner.
  current = false;
  oldTrust.report("pin");
  bridge.emit({ id: "socket-1", type: "open", value: "" });
  expect(oldTrust.failure).toBe("pin");
  expect(opened).toBe(0);
});

it("ignores a late open after close without touching trust or frames", () => {
  const bridge = fakeBridge();
  const trust = new TrustMonitor();
  trust.report("pin");
  const seen = events();
  const transport = bridgeSocketTransport(bridge, {
    url: SOCKET_URL,
    fingerprint: PIN,
    id: () => "socket-1",
    trust,
  });
  transport.open(seen);
  transport.close();
  // The native socket still reports open late: ownership is already released,
  // so it delivers nothing and leaves the failure for the next binding.
  bridge.emit({ id: "socket-1", type: "open", value: "" });
  bridge.emit({ id: "socket-1", type: "message", value: "late" });
  expect(seen.opened).toBe(0);
  expect(seen.messages).toEqual([]);
  expect(trust.failure).toBe("pin");
});

it("drops frames once the epoch guard says the runtime no longer owns its machine", () => {
  const bridge = fakeBridge();
  let current = true;
  const seen = events();
  const transport = bridgeSocketTransport(bridge, {
    url: SOCKET_URL,
    fingerprint: PIN,
    id: () => "socket-1",
    isCurrent: () => current,
  });
  transport.open(seen);
  bridge.emit({ id: "socket-1", type: "message", value: "first" });
  expect(seen.messages).toEqual(["first"]);
  current = false;
  bridge.emit({ id: "socket-1", type: "message", value: "stale" });
  expect(seen.messages).toEqual(["first"]);
});

it("delivers binary frames as bytes and fails closed on unreadable frames", () => {
  const bridge = fakeBridge();
  const seen = events();
  const transport = bridgeSocketTransport(bridge, {
    url: SOCKET_URL,
    fingerprint: PIN,
    id: () => "socket-1",
  });
  transport.open(seen);
  bridge.emit({ id: "socket-1", type: "binary", value: "aGVsbG8=" });
  expect(seen.binaries).toHaveLength(1);
  expect(Array.from(seen.binaries[0] ?? [])).toEqual([104, 101, 108, 108, 111]);
  bridge.emit({ id: "socket-1", type: "binary", value: "!!!not-base64!!!" });
  expect(seen.closes).toEqual([{ code: 1002, reason: "Unreadable frame" }]);
});

it("decodes base64 without padding or globals", () => {
  expect(Array.from(base64ToBytes("aGVsbG8"))).toEqual([104, 101, 108, 108, 111]);
  expect(Array.from(base64ToBytes(""))).toEqual([]);
  expect(() => base64ToBytes("a!")).toThrow();
});

it("fails closed on a non-WSS endpoint before opening any socket", () => {
  const bridge = fakeBridge();
  const open = vi.spyOn(bridge, "pinnedSocketOpen");
  expect(() =>
    bridgeSocketTransport(bridge, { url: "ws://127.0.0.1:4345/", fingerprint: PIN, id: () => "x" }),
  ).toThrow();
  expect(open).not.toHaveBeenCalled();
});
