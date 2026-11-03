import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { machineAccount } from "./machine-account.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const signedOut = { signedIn: false, machineCode: { set: false } };

/** A daemon's account routes as a real local HTTP server, recording what reached it. */
async function daemon(
  reply: (url: string) => { status: number; body: unknown } = () => ({
    status: 200,
    body: signedOut,
  }),
) {
  const seen: { method?: string; url?: string; auth?: string; body: string }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      seen.push({
        ...(request.method ? { method: request.method } : {}),
        ...(request.url ? { url: request.url } : {}),
        ...(request.headers.authorization ? { auth: request.headers.authorization } : {}),
        body,
      });
      const answer = reply(request.url ?? "");
      response.statusCode = answer.status;
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return { url: `ws://127.0.0.1:${address.port}/`, seen };
}

const token = "c".repeat(64);
const session = "s".repeat(43);
const origin = "https://account.example";

it("signs this computer's daemon in with the app's saved session, then out", async () => {
  const local = await daemon();
  const connection = { mode: "daemon", url: local.url, token, localHostId: "host" } as const;
  const saved = async (asked: string) => (asked === origin ? session : null);
  await machineAccount(connection, { op: "signIn", origin }, saved);
  await machineAccount(connection, { op: "signOut" }, saved);
  expect(local.seen).toEqual([
    {
      method: "PUT",
      url: "/v1/ace-account",
      auth: `Bearer ${token}`,
      body: JSON.stringify({ origin, token: session }),
    },
    { method: "DELETE", url: "/v1/ace-account", auth: `Bearer ${token}`, body: "" },
  ]);
});

it("signing in without a saved app session asks for the app's sign-in and calls nothing", async () => {
  const local = await daemon();
  const connection = { mode: "daemon", url: local.url, token, localHostId: "host" } as const;
  await expect(
    machineAccount(connection, { op: "signIn", origin }, async () => null),
  ).rejects.toThrow("Sign in to your ace account in this app first.");
  expect(local.seen).toEqual([]);
});

it("a remote daemon is never signed in with the app's session", async () => {
  const remote = await daemon();
  await expect(
    machineAccount(
      { mode: "daemon", url: remote.url, token },
      { op: "signIn", origin },
      async () => session,
    ),
  ).rejects.toThrow();
  expect(remote.seen).toEqual([]);
});

it("sets and clears the machine code and returns the daemon's new state", async () => {
  const local = await daemon((url) => ({
    status: 200,
    body: { signedIn: true, machineCode: { set: url === "/v1/machine-code" } },
  }));
  const connection = { mode: "daemon", url: local.url, token, localHostId: "host" } as const;
  const set = await machineAccount(connection, { op: "setCode", code: "2468" }, async () => null);
  expect(set.machineCode.set).toBe(true);
  await machineAccount(connection, { op: "clearCode" }, async () => null);
  expect(local.seen.map((each) => [each.method, each.url, each.body])).toEqual([
    ["PUT", "/v1/machine-code", JSON.stringify({ code: "2468" })],
    ["DELETE", "/v1/machine-code", ""],
  ]);
});

it("the daemon's refusal reaches the person in its own words", async () => {
  const local = await daemon(() => ({
    status: 400,
    body: { error: "A machine code has 4 to 128 characters." },
  }));
  const connection = { mode: "daemon", url: local.url, token, localHostId: "host" } as const;
  await expect(
    machineAccount(connection, { op: "setCode", code: "2468" }, async () => null),
  ).rejects.toThrow("A machine code has 4 to 128 characters.");
});
