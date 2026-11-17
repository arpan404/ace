import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { DeviceId, type Device } from "@ace/protocol";
import { iconsHttp } from "./icons-http.ts";

const token = "a".repeat(64);
const ref = "b".repeat(64);
const device: Device = {
  id: DeviceId.parse("device-1"),
  name: "Laptop",
  scopes: ["read"],
  createdAt: 1,
  lastSeenAt: 1,
  revokedAt: null,
};
let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function serve(read: () => Promise<Buffer | undefined>, logged: unknown[]) {
  const handler = iconsHttp(
    { webOrigins: [], log: (error) => logged.push(error), icons: { read } },
    {
      localBearer: (bearer) => (bearer === token ? device : undefined),
      deviceBearer: () => undefined,
    },
    false,
    (_request, response) => {
      response.statusCode = 404;
      response.end();
    },
  );
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/v1/icons/${ref}`;
}

it("answers 500 and keeps serving when the icon store fails a read", async () => {
  const logged: unknown[] = [];
  let fail = true;
  const url = await serve(async () => {
    if (fail) throw new Error("icon cache unreadable");
    return Buffer.from("png");
  }, logged);
  const headers = { authorization: `Bearer ${token}` };

  const failed = await fetch(url, { headers });
  expect(failed.status).toBe(500);
  expect(logged).toEqual([new Error("icon cache unreadable")]);

  fail = false;
  const served = await fetch(url, { headers });
  expect(served.status).toBe(200);
  expect(Buffer.from(await served.arrayBuffer()).toString()).toBe("png");
});
