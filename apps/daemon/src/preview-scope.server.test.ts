import { once } from "node:events";
import { createServer, request } from "node:http";
import { expect, test } from "vitest";
import { z } from "zod";
import { cleanups, setup } from "./remote-test-support.ts";
import { token } from "./socket-test-support.ts";

const Link = z.object({ url: z.url() });

const call = (url: string, method = "GET", cookie = "") => {
  const target = new URL(url);
  return new Promise<{ status: number; cookie: string }>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: target.port,
        path: target.pathname + target.search,
        method,
        headers: { host: target.host, cookie },
        agent: false,
      },
      (res) => {
        res.resume();
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            cookie: res.headers["set-cookie"]?.[0]?.split(";")[0] ?? "",
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
};

test("read-only devices cannot obtain mutation-capable previews and revoked operators cannot mutate", async () => {
  let mutations = 0;
  const upstream = createServer((req, res) => {
    if (req.method === "POST") mutations++;
    res.end("app");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        upstream.close(() => resolve());
        upstream.closeAllConnections();
      }),
  );
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing upstream listener");
  const f = await setup({ preview: { host: "127.0.0.1", wildcardHost: "preview.test" } });
  const gateway = f.server.preview;
  if (!gateway) throw new Error("Missing preview gateway");
  gateway.register({ port: address.port });
  const path = `/v1/previews/${address.port}/link`;
  const reader = await f.pair(["read"]);
  await expect(f.remoteRequest(path, { method: "POST", token: reader.token })).rejects.toThrow(
    "HTTP 403",
  );
  expect(mutations).toBe(0);
  const operator = await f.pair(["operate"]);
  const link = Link.parse(await f.remoteRequest(path, { method: "POST", token: operator.token }));
  const login = await call(link.url);
  expect(login.status).toBe(303);
  expect(login.cookie).not.toBe("");
  const origin = new URL(link.url).origin;
  expect((await call(origin, "POST", login.cookie)).status).toBe(200);
  expect(mutations).toBe(1);
  await f.request(`/v1/devices/${operator.device.id}`, { method: "DELETE", token });
  expect((await call(origin, "POST", login.cookie)).status).toBe(401);
  expect(mutations).toBe(1);
});
