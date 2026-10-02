import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { expect, test } from "vitest";
import { startDaemon, readConfig } from "./index.ts";

function get(url: string, cookie = "") {
  const target = new URL(url);
  return new Promise<{ status: number; body: string; cookie: string }>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: target.port,
        path: target.pathname + target.search,
        headers: { host: target.host, cookie },
        agent: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            cookie: res.headers["set-cookie"]?.[0]?.split(";")[0] ?? "",
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("daemon startup with a model catalog also serves its optional preview gateway", async ({
  onTestFinished,
}) => {
  const home = await mkdtemp(join(tmpdir(), "ace-preview-startup-"));
  const upstream = createServer((_req, res) => res.end("startup preview"));
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  onTestFinished(async () => {
    try {
      await daemon?.close();
    } finally {
      try {
        await new Promise<void>((resolve) => {
          upstream.close(() => resolve());
          upstream.closeAllConnections();
        });
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing upstream address");
  daemon = await startDaemon(
    readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    undefined,
    [],
    undefined,
    [],
    { host: "127.0.0.1", wildcardHost: "preview.test" },
  );
  const paired = daemon.store.devices.create("Operator", ["operate"], 1000);
  const preview = daemon.preview;
  if (!preview) throw new Error("Missing preview gateway");
  const origin = preview.register({ port: address.port });
  const login = await get(
    await preview.mintLink({ port: address.port, deviceToken: paired.token }),
  );
  expect(login.status).toBe(303);
  expect((await get(origin, login.cookie)).body).toBe("startup preview");
  expect(daemon.models.list({ offset: 0, limit: 1 }).models).toEqual([]);
});
