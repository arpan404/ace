import { once } from "node:events";
import { createServer, request } from "node:http";
import { z } from "zod";
import { expect, test } from "vitest";
import { cleanups, setup } from "./remote-test-support.ts";
import { token } from "./socket-test-support.ts";

const previewOptions = { host: "127.0.0.1", wildcardHost: "preview.test" };
const Link = z.object({ url: z.url() });
const call = (url: string, cookie?: string) => {
  const target = new URL(url);
  return new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: target.port,
        path: target.pathname + target.search,
        headers: { host: target.host, ...(cookie ? { cookie } : {}) },
      },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
};
async function upstream() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: paired\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing upstream address");
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return address.port;
}

test("only a paired device can mint a preview link through the daemon API", async () => {
  const f = await setup({ preview: previewOptions });
  const gateway = f.server.preview;
  if (!gateway) throw new Error("Missing preview gateway");
  const port = await upstream();
  gateway.register({ port });
  const path = `/v1/previews/${port}/link`;
  await expect(f.request(path, { method: "POST", token })).rejects.toThrow("HTTP 403");
  await expect(f.remoteRequest(path, { method: "POST" })).rejects.toThrow("HTTP 401");
  const paired = await f.pair(["read"]);
  const { url } = Link.parse(await f.remoteRequest(path, { method: "POST", token: paired.token }));
  const login = await call(url);
  expect(login.statusCode).toBe(303);
  const cookie = login.headers["set-cookie"]?.[0]?.split(";")[0];
  if (!cookie) throw new Error("Missing preview cookie");
  login.resume();
  const response = await call(new URL(url).origin, cookie);
  const data = once(response, "data");
  expect(response.statusCode).toBe(200);
  expect(String((await data)[0])).toContain("data: paired");
  const closed = new Promise<void>((resolve) => response.once("close", () => resolve()));
  response.on("error", () => {});
  await f.request(`/v1/devices/${paired.device.id}`, { method: "DELETE", token });
  await closed;
  await expect(f.remoteRequest(path, { method: "POST", token: paired.token })).rejects.toThrow(
    "HTTP 403",
  );
  const blocked = await call(new URL(url).origin, cookie);
  expect(blocked.statusCode).toBe(401);
  blocked.resume();
});

test("daemon shutdown closes its preview streams and listener", async () => {
  const f = await setup({ preview: previewOptions });
  const gateway = f.server.preview;
  if (!gateway) throw new Error("Missing preview gateway");
  const port = await upstream();
  const origin = gateway.register({ port });
  const paired = await f.pair();
  const login = await call(await gateway.mintLink({ port, deviceToken: paired.token }));
  const cookie = login.headers["set-cookie"]?.[0]?.split(";")[0];
  if (!cookie) throw new Error("Missing preview cookie");
  login.resume();
  const response = await call(origin, cookie);
  response.resume();
  const closed = new Promise<void>((resolve) => response.once("close", () => resolve()));
  response.on("error", () => {});
  await f.server.close();
  await closed;
  await expect(call(origin, cookie)).rejects.toThrow();
});
