import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { pairedSocketCredential } from "./access-ticket.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

it("each paired socket attempt exchanges the device token for a fresh ticket", async () => {
  const token = "a".repeat(64);
  const authorizations: (string | undefined)[] = [];
  let attempts = 0;
  const server = createServer((request, response) => {
    authorizations.push(request.headers.authorization);
    if (
      request.url !== "/v1/tickets" ||
      request.method !== "POST" ||
      request.headers.authorization !== `Bearer ${token}`
    ) {
      response.writeHead(401).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({ ticket: (++attempts).toString(16).padStart(64, "0"), expiresAt: 1000 }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  const credential = pairedSocketCredential({
    url: `ws://127.0.0.1:${address.port}/`,
    token: async () => token,
    fetch: (input, init) => fetch(input, init),
  });
  expect(await credential()).toEqual({ ticket: "1".padStart(64, "0") });
  expect(await credential()).toEqual({ ticket: "2".padStart(64, "0") });
  expect(authorizations).toEqual([`Bearer ${token}`, `Bearer ${token}`]);
});
