import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { followAppAccount, handsOverOnSignIn, signsOutOnSignOut } from "./account-write.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const origin = "https://account.example";
const other = "https://other.example";
const session = "s".repeat(43);
const person = (id: string) => ({ id, email: `${id}@example.com`, name: id });
const signedOut = { signedIn: false, machineCode: { set: false }, sessionId: null };
const signedIn = (id: string, source?: "login" | "handover", at = origin) => ({
  signedIn: true,
  origin: at,
  account: person(id),
  expiresAt: 2_000_000_000_000,
  machineCode: { set: false },
  sessionId: "held",
  ...(source ? { source } : {}),
});
/** A daemon that predates conditional account changes: no `sessionId`. */
const unconditional = <T extends { sessionId: string | null }>(status: T) => {
  const { sessionId: _, ...rest } = status;
  return rest;
};
const loggingIn = {
  ...signedOut,
  login: { url: "https://account.example/login?id=1", expiresAt: 2_000_000_000_000 },
};
const lapsed = (id: string, source: "login" | "handover") => ({
  ...signedIn(id, source),
  signedIn: false,
});

it.each([
  ["signed out", signedOut, true],
  ["signed in through the app, same account", signedIn("user_a", "handover"), true],
  ["signed in on its own, same account", signedIn("user_a", "login"), false],
  ["signed in on its own, another account", signedIn("user_b", "login"), false],
  ["signed in through the app, another account", signedIn("user_b", "handover"), false],
  ["signed in through the app at another origin", signedIn("user_a", "handover", other), false],
  ["signed in by a daemon that predates `source`", signedIn("user_a"), false],
  ["signed out, but can't check its session when changed", unconditional(signedOut), false],
  ["signed out, with a sign-in under way on the machine", loggingIn, false],
  ["lapsed on the same account, signed in through the app", lapsed("user_a", "handover"), true],
  // Its own sign-in stays its own after it lapses: only Settings' Switch replaces it.
  ["lapsed on the same account, signed in on its own", lapsed("user_a", "login"), false],
  ["lapsed on another account", lapsed("user_b", "handover"), false],
] as const)("app signs in as user_a, daemon %s: hands over = %s", (_name, status, expected) => {
  expect(handsOverOnSignIn(status, { origin, accountId: "user_a" })).toBe(expected);
});

it("a daemon that names an account is left alone when the app's own account can't be checked", () => {
  expect(handsOverOnSignIn(lapsed("user_a", "handover"), { origin, accountId: undefined })).toBe(
    false,
  );
  expect(handsOverOnSignIn(signedOut, { origin, accountId: undefined })).toBe(true);
});

it.each([
  ["signed in through the app", signedIn("user_a", "handover"), true],
  ["signed in on its own", signedIn("user_a", "login"), false],
  ["signed in through the app at another origin", signedIn("user_a", "handover", other), false],
  ["signed in by a daemon that predates `source`", signedIn("user_a"), false],
  [
    "signed in through the app, but can't check its session",
    unconditional(signedIn("user_a", "handover")),
    false,
  ],
  ["signed out", signedOut, false],
] as const)("app signs out, daemon %s: signs it out = %s", (_name, status, expected) => {
  expect(signsOutOnSignOut(status, origin)).toBe(expected);
});

/** This computer's daemon's account route as a real local HTTP server, recording requests. */
async function daemon(status: unknown) {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      seen.push(
        `${request.method} ${request.headers["if-match"] ?? request.headers["if-none-match"] ?? ""}`.trim(),
      );
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
  };
}
const signedInApp = { saved: async () => ({ [origin]: session }), accountOf: async () => "user_a" };
const signedOutApp = { saved: async () => ({}), accountOf: async () => "user_a" };

it("the app's sign-in never moves a daemon signed in on its own to another account", async () => {
  const { seen, local } = await daemon(signedIn("user_b", "login"));
  expect(await followAppAccount(local, origin, signedInApp)).toBe("left");
  expect(seen).toEqual(["GET"]);
});

it("the app's sign-in hands its session to a signed-out daemon, only while it still has none", async () => {
  const { seen, local } = await daemon(signedOut);
  expect(await followAppAccount(local, origin, signedInApp)).toBe("handedOver");
  expect(seen).toEqual(["GET", "PUT *"]);
});

it("the app's sign-out signs out only a daemon whose session came from the app", async () => {
  const own = await daemon(signedIn("user_a", "login"));
  expect(await followAppAccount(own.local, origin, signedOutApp)).toBe("left");
  expect(own.seen).toEqual(["GET"]);
  const handed = await daemon(signedIn("user_a", "handover"));
  expect(await followAppAccount(handed.local, origin, signedOutApp)).toBe("signedOut");
  expect(handed.seen).toEqual(["GET", 'DELETE "held"']);
});
