import { latest, native } from "./test-host.ts";
import { expect, test, vi } from "vitest";
import {
  GRANT_LIFETIME_MS,
  grantPublicKey,
  signGrant,
  verifyGrant,
  type GrantClaims,
} from "@ace/account-grant";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import type { HostEntries } from "@ace/native-host";

/*
 * An account machine through the bridge's own entry points, as Swift drives them: `aceStart`
 * with an account config, the socket reaching a fake daemon that enforces device grants the
 * way the real one does (ADR 0114): the welcome says how long the hello's grant has left, a
 * valid `account.grant.refresh` moves the expiry on, and with none by expiry plus 30 s the
 * socket is closed with 4014. The clock is fake, so ten minutes pass in a moment.
 */

vi.useFakeTimers({
  toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
});
await import("./main.ts");

const GRACE_MS = 30_000;
const key = { id: "k1", privateKey: new Uint8Array(32).fill(9) };
const keys = { keys: [grantPublicKey(key)] };
const deviceId = "ios-grant-phone";
const issue = () =>
  signGrant(
    {
      kind: "device",
      account: "user_1",
      subject: deviceId,
      iat: Date.now(),
      exp: Date.now() + GRANT_LIFETIME_MS,
    },
    key,
  );

const daemon = new FakeDaemon({ clock: Date.now, hostId: "ios-account-host", token: "inner" });
const entries = globalThis as unknown as HostEntries;
native.ack = (accepted) => entries.aceAck(accepted);

/** Every socket the bridge opened, with how and when the daemon side ended it. */
const opened: { closedWith?: number }[] = [];
const refreshes: { at: number; claims: GrantClaims }[] = [];
const sockets = new Map<string, { send(text: string): void; close(): void }>();
native.socket = (id, action, value) => {
  if (action === "open") {
    const record: { closedWith?: number } = {};
    opened.push(record);
    const inner = fakeTransport(daemon);
    let expiresAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const close = (code: number) => {
      clearTimeout(timer);
      record.closedWith = code;
      sockets.delete(id);
      inner.close();
      entries.aceSocket(id, "close", String(code));
    };
    const enforce = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          if (Date.now() >= expiresAt + GRACE_MS) close(4014);
          else enforce();
        },
        expiresAt + GRACE_MS - Date.now(),
      );
    };
    const admit = (grant: string) => verifyGrant(grant, keys, Date.now(), "device");
    sockets.set(id, {
      send(text) {
        const message = JSON.parse(text) as Record<string, unknown>;
        if (message.type === "hello" && typeof message.grant === "string") {
          expiresAt = admit(message.grant).exp;
          enforce();
          const { grant: _grant, machineCode: _code, ...rest } = message;
          inner.send(JSON.stringify({ ...rest, token: "inner" }));
          return;
        }
        if (message.type === "account.grant.refresh" && typeof message.grant === "string") {
          const claims = admit(message.grant);
          refreshes.push({ at: Date.now(), claims });
          expiresAt = Math.max(expiresAt, claims.exp);
          enforce();
          const grantTtlMs = expiresAt - Date.now();
          const result = { ok: true, grantTtlMs };
          const reply = {
            type: "account.grant.refresh.result",
            requestId: message.requestId,
            result,
          };
          queueMicrotask(() => entries.aceSocket(id, "message", JSON.stringify(reply)));
          return;
        }
        inner.send(text);
      },
      close: () => close(1000),
    });
    inner.open({
      open: () => entries.aceSocket(id, "open", ""),
      message(text) {
        const message = JSON.parse(text) as Record<string, unknown>;
        const welcome =
          message.type === "welcome" ? { ...message, grantTtlMs: expiresAt - Date.now() } : message;
        entries.aceSocket(id, "message", JSON.stringify(welcome));
      },
      binary: (bytes) => entries.aceSocket(id, "binary", bytes),
      close: (code) => entries.aceSocket(id, "close", String(code)),
    });
  } else if (action === "send") sockets.get(id)?.send(value);
  else sockets.get(id)?.close();
};

// The hello's grant is the one the relay socket fetched (`credential`, which may hand back a
// kept grant); a refresh asks for one fetched now (`credential.fresh`).
let helloGrant = issue();
const fetched: number[] = [];
native.calls.set("credential", () => JSON.stringify({ grant: helloGrant }));
native.calls.set("credential.fresh", () => {
  fetched.push(Date.now());
  return JSON.stringify({ grant: issue() });
});
for (const operation of [
  "storage.load",
  "storage.save",
  "storage.host.load",
  "storage.host.save",
  "storage.write",
  "storage.reads.load",
  "storage.reads.save",
  "storage.devices.load",
  "storage.devices.save",
  "storage.dismissed.load",
  "storage.dismissed.save",
  "inbox.checkpoint",
  "snapshot.get",
  "snapshot.set",
  "snapshot.thread.get",
  "snapshot.thread.put",
  "snapshot.drop",
  "snapshot.clear",
])
  native.calls.set(operation, () => "");
native.calls.set("storage.records", () => "[]");
native.calls.set("snapshot.index", () => "[]");
native.calls.set("snapshot.size", () => "0");

/** Let the fake clock run, a second at a time so every promise chain settles in between. */
async function pass(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 1000)
    await vi.advanceTimersByTimeAsync(Math.min(1000, left));
}

test("an account socket opened through the bridge sends a fresh grant before expiry and stays open past it", async () => {
  const started = Date.now();
  helloGrant = issue();
  entries.aceStart(
    JSON.stringify({ deviceId, hostId: "ios-account-relay-host", itemLimit: 400, account: {} }),
  );
  for (let wait = 0; wait < 100 && latest("connection")?.state !== "ready"; wait++)
    await vi.advanceTimersByTimeAsync(50);
  expect(latest("connection")?.state).toBe("ready");

  // Past the hello grant's expiry and grace, and past the first refreshed grant's too.
  await pass(2 * GRANT_LIFETIME_MS + GRACE_MS + 5_000);

  expect(opened).toHaveLength(1);
  expect(opened[0]?.closedWith).toBeUndefined();
  expect(latest("connection")?.state).toBe("ready");
  // The first refresh lands before the hello's grant runs out, carrying a newly fetched grant.
  const first = refreshes[0];
  expect(first?.at).toBeLessThan(started + GRANT_LIFETIME_MS);
  expect(first?.claims.iat).toBeGreaterThan(started);
  expect(refreshes.length).toBeGreaterThanOrEqual(2);
  expect(fetched.length).toBe(refreshes.length);
});
