import { createServer, type IncomingMessage } from "node:http";
import { afterEach, expect, it } from "vitest";
import { accountSync } from "./account-sync.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const origin = "https://account.example";
const tokens: Record<string, string> = { ["a".repeat(43)]: "user_a", ["b".repeat(43)]: "user_b" };
const tokenA = "a".repeat(43);
const tokenB = "b".repeat(43);
const accountOf = async (_origin: string, token: string) => tokens[token] ?? "unknown";

type Held = { account: string; source: "handover" | "login"; id: string };

/**
 * This computer's daemon's account route as a real local HTTP server: one session, a session id
 * that changes with it, and `If-Match` / `If-None-Match: *` refused with 412 once it changed, as
 * the daemon does. `hold(method)` keeps the next such request waiting until released.
 */
async function daemon() {
  let session: Held | undefined;
  let ids = 0;
  const adopted: string[] = [];
  const holds = new Map<string, { reached: PromiseWithResolvers<void>; go: Promise<void> }>();
  const status = () =>
    session
      ? {
          signedIn: true,
          origin,
          account: { id: session.account, email: `${session.account}@example.com`, name: "A" },
          expiresAt: 2_000_000_000_000,
          source: session.source,
          sessionId: session.id,
          machineCode: { set: false },
        }
      : { signedIn: false, sessionId: null, machineCode: { set: false } };
  const stillHeld = (request: IncomingMessage) => {
    const match = request.headers["if-match"];
    if (typeof match === "string") return match === `"${session?.id}"`;
    if (request.headers["if-none-match"] === "*") return session === undefined;
    return true;
  };
  const adopt = (next: Omit<Held, "id"> | undefined) => {
    session = next && { ...next, id: `s${++ids}` };
    if (next) adopted.push(`${next.account} (${next.source})`);
  };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      const method = request.method ?? "GET";
      const hold = holds.get(method);
      holds.delete(method);
      hold?.reached.resolve();
      void (hold?.go ?? Promise.resolve()).then(() => {
        if (method !== "GET" && !stillHeld(request)) {
          response.statusCode = 412;
          return response.end("{}");
        }
        if (method === "PUT") {
          const { token } = JSON.parse(body) as { token: string };
          adopt({ account: tokens[token] ?? "unknown", source: "handover" });
        }
        if (method === "DELETE") adopt(undefined);
        response.end(JSON.stringify(status()));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const connection = {
    mode: "daemon",
    url: `ws://127.0.0.1:${address.port}/`,
    token: "c".repeat(64),
    localHostId: "host",
  } as const;
  return {
    connection,
    adopted,
    status,
    /** The machine's own `ace login` finishing. */
    login: (account: string) => adopt({ account, source: "login" }),
    /** Keeps the next `method` request waiting; resolves `reached` once it arrives. */
    hold(method: string) {
      const go = Promise.withResolvers<void>();
      const reached = Promise.withResolvers<void>();
      holds.set(method, { reached, go: go.promise });
      return { reached: reached.promise, release: () => go.resolve() };
    },
  };
}

/** The app's saved sessions, as the person signs in and out. */
function app(daemonConnection: Awaited<ReturnType<typeof daemon>>["connection"]) {
  let saved: Record<string, string> = {};
  const sync = accountSync({
    connection: async () => daemonConnection,
    saved: async () => saved,
    accountOf,
  });
  return {
    sync,
    signIn(token: string) {
      saved = { [origin]: token };
      return sync.followApp(origin);
    },
    signOut() {
      saved = {};
      return sync.followApp(origin);
    },
  };
}

it("signing out while the sign-in's handover is still landing leaves the machine signed out", async () => {
  const machine = await daemon();
  const window = app(machine.connection);
  const put = machine.hold("PUT");
  const signedIn = window.signIn(tokenA);
  await put.reached;
  const signedOut = window.signOut();
  // Were the sign-out to read the machine now, it would see no session and leave it on A.
  await new Promise((resolve) => setTimeout(resolve, 50));
  put.release();
  await Promise.all([signedIn, signedOut]);
  expect(machine.adopted).toEqual(["user_a (handover)"]);
  expect(machine.status()).toMatchObject({ signedIn: false });
});

it("a sign-in replaced before its handover reads the machine is dropped for the newest one", async () => {
  const machine = await daemon();
  const window = app(machine.connection);
  const get = machine.hold("GET");
  const first = window.signIn(tokenA);
  await get.reached;
  const out = window.signOut();
  const second = window.signIn(tokenB);
  get.release();
  await Promise.all([first, out, second]);
  // Account A's session never reaches the machine; it follows the app to B.
  expect(machine.adopted).toEqual(["user_b (handover)"]);
  expect(machine.status()).toMatchObject({ signedIn: true, account: { id: "user_b" } });
});

it("the machine's own sign-in finishing during the app's handover is kept", async () => {
  const machine = await daemon();
  const window = app(machine.connection);
  const put = machine.hold("PUT");
  const signedIn = window.signIn(tokenA);
  await put.reached;
  machine.login("user_b");
  put.release();
  await signedIn;
  expect(machine.status()).toMatchObject({ account: { id: "user_b" }, source: "login" });
  // And the app's sign-out never touches it.
  await window.signOut();
  expect(machine.status()).toMatchObject({ account: { id: "user_b" }, source: "login" });
});

it("a daemon that comes back while the app signs out is not handed the old session", async () => {
  const machine = await daemon();
  const window = app(machine.connection);
  await window.signIn(tokenA);
  await window.signOut();
  const get = machine.hold("GET");
  // Signed in again; the daemon restarts; the person signs out before the restart's check reads it.
  const again = window.signIn(tokenA);
  await get.reached;
  const resumed = window.sync.resume();
  const out = window.signOut();
  get.release();
  await Promise.all([again, resumed, out]);
  expect(machine.adopted).toEqual(["user_a (handover)"]);
  expect(machine.status()).toMatchObject({ signedIn: false });
});
