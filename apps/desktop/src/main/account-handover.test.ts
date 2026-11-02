import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { handAccountToDaemon } from "./account-handover.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function daemon() {
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
      response.end("{}");
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

it("the local daemon gets the app's ace session on sign-in and forgets it on sign-out", async () => {
  const local = await daemon();
  const connection = { mode: "daemon", url: local.url, token, localHostId: "host" } as const;
  await handAccountToDaemon(connection, "https://account.example", session);
  await handAccountToDaemon(connection, "https://account.example", null);
  expect(local.seen).toEqual([
    {
      method: "PUT",
      url: "/v1/ace-account",
      auth: `Bearer ${token}`,
      body: JSON.stringify({ origin: "https://account.example", token: session }),
    },
    { method: "DELETE", url: "/v1/ace-account", auth: `Bearer ${token}`, body: "" },
  ]);
});

it("a remote daemon is never handed the app's ace session", async () => {
  const remote = await daemon();
  await handAccountToDaemon(
    { mode: "daemon", url: remote.url, token },
    "https://a.example",
    session,
  );
  expect(remote.seen).toEqual([]);
});
