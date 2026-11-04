import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import type { DaemonStatus } from "../shared/contract.ts";
import { followDaemonAccount, planHandover, resumeDaemonAccount } from "./account-follow.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const origin = "https://account.example";
const session = "s".repeat(43);
const person = (id: string) => ({ id, email: `${id}@example.com`, name: id });
const signedOut = { signedIn: false, machineCode: { set: false }, sessionId: null };
const signedInAs = (id: string, source: "handover" | "login" = "handover") => ({
  signedIn: true,
  origin,
  account: person(id),
  expiresAt: 2_000_000_000_000,
  machineCode: { set: false },
  source,
  sessionId: "held",
});
/** A session that expired or the backend dropped: the daemon still names its account. */
const lapsed = (id: string, source: "handover" | "login" = "handover") => ({
  ...signedInAs(id, source),
  signedIn: false,
});

it("a daemon that is signed in, to this account or another, is left as it is", () => {
  expect(planHandover(signedInAs("user_a"), { [origin]: session })).toBeUndefined();
  expect(planHandover(signedInAs("user_b"), { [origin]: session })).toBeUndefined();
});

it("a signed-out daemon gets the app's session when the app has exactly one", () => {
  expect(planHandover(signedOut, { [origin]: session })).toEqual({
    origin,
    token: session,
    expected: null,
  });
  expect(planHandover(signedOut, {})).toBeUndefined();
  expect(
    planHandover(signedOut, { [origin]: session, "https://other.example": session }),
  ).toBeUndefined();
});

it("a daemon whose session lapsed gets one only for its own origin and account", () => {
  const other = "https://other.example";
  expect(planHandover(lapsed("user_a"), { [other]: session, [origin]: session })).toEqual({
    origin,
    token: session,
    expected: "held",
    sameAccountAs: "user_a",
  });
  expect(planHandover(lapsed("user_a"), { [other]: session })).toBeUndefined();
});

it("a daemon's own lapsed sign-in, one under way, or one it can't check is left alone", () => {
  expect(planHandover(lapsed("user_a", "login"), { [origin]: session })).toBeUndefined();
  const loggingIn = {
    ...signedOut,
    login: { url: `${origin}/login`, expiresAt: 2_000_000_000_000 },
  };
  expect(planHandover(loggingIn, { [origin]: session })).toBeUndefined();
  const { sessionId: _, ...older } = signedOut;
  expect(planHandover(older, { [origin]: session })).toBeUndefined();
});

/** A daemon's account routes as a real local HTTP server, recording what reached it. */
async function daemon(status: unknown) {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      seen.push(`${request.method} ${request.url} ${body}`.trim());
      response.end(JSON.stringify(status));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const url = `ws://127.0.0.1:${address.port}/`;
  return {
    seen,
    local: { mode: "daemon", url, token: "c".repeat(64), localHostId: "host" } as const,
    remote: { mode: "daemon", url, token: "c".repeat(64) } as const,
  };
}

const handover = `PUT /v1/ace-account ${JSON.stringify({ origin, token: session })}`;
const deps = (account = "user_a") => ({
  saved: async () => ({ [origin]: session }),
  accountOf: async () => account,
});

it("a local daemon that came up signed out is handed the app's session", async () => {
  const { seen, local } = await daemon(signedOut);
  expect(await resumeDaemonAccount(local, deps())).toBe(true);
  expect(seen).toEqual(["GET /v1/ace-account", handover]);
});

it("a local daemon signed in to another account is never switched", async () => {
  const { seen, local } = await daemon(signedInAs("user_b"));
  expect(await resumeDaemonAccount(local, deps())).toBe(false);
  expect(seen).toEqual(["GET /v1/ace-account"]);
});

it("a lapsed daemon session is renewed for the same account and left alone for another", async () => {
  const same = await daemon(lapsed("user_a"));
  expect(await resumeDaemonAccount(same.local, deps("user_a"))).toBe(true);
  expect(same.seen).toEqual(["GET /v1/ace-account", handover]);
  const other = await daemon(lapsed("user_b"));
  expect(await resumeDaemonAccount(other.local, deps("user_a"))).toBe(false);
  expect(other.seen).toEqual(["GET /v1/ace-account"]);
});

it("a remote daemon is never asked or handed the app's session", async () => {
  const { seen, remote } = await daemon(signedOut);
  expect(await resumeDaemonAccount(remote, deps())).toBe(false);
  expect(seen).toEqual([]);
});

function runtime(initial: DaemonStatus["state"]) {
  let current: DaemonStatus = { state: initial, source: "app", restarts: 0, paused: false };
  const listeners = new Set<(status: DaemonStatus) => void>();
  return {
    current: () => current,
    onStatus(listener: (status: DaemonStatus) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(state: DaemonStatus["state"], restarts = current.restarts) {
      current = { ...current, state, restarts };
      for (const listener of listeners) listener(current);
    },
  };
}

it("the daemon's account is checked when the app starts and each time the daemon comes back", async () => {
  const daemonRuntime = runtime("running");
  let runs = 0;
  followDaemonAccount(daemonRuntime, async () => void runs++);
  await Promise.resolve();
  expect(runs).toBe(1);
  daemonRuntime.set("running");
  await Promise.resolve();
  expect(runs).toBe(1);
  daemonRuntime.set("restarting");
  daemonRuntime.set("running");
  await new Promise((resolve) => setImmediate(resolve));
  expect(runs).toBe(2);
  // A crash the supervisor restarts on its own may only show as a new restart count.
  daemonRuntime.set("running", 1);
  await new Promise((resolve) => setImmediate(resolve));
  expect(runs).toBe(3);
});

it("a daemon that starts during a check is checked again once that check ends", async () => {
  const daemonRuntime = runtime("starting");
  const gates: PromiseWithResolvers<void>[] = [];
  followDaemonAccount(daemonRuntime, () => {
    const gate = Promise.withResolvers<void>();
    gates.push(gate);
    return gate.promise;
  });
  expect(gates).toHaveLength(0);
  daemonRuntime.set("running");
  daemonRuntime.set("stopped");
  daemonRuntime.set("running");
  expect(gates).toHaveLength(1);
  gates[0]?.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  expect(gates).toHaveLength(2);
});
