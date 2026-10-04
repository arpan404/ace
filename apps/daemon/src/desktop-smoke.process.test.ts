import { once } from "node:events";
import { createServer, request } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { expect, test } from "vitest";
import { DeviceId, PairingResponse, ThreadId } from "@ace/protocol";
import { accessRequest, redeemPairing } from "./client-access.ts";
import { copyTlsFixture, launchDaemon } from "./process-test-support.ts";
import { Client } from "./socket-test-support.ts";

function get(url: string, cookie = "", origin?: string) {
  const target = new URL(url);
  return new Promise<{ status: number; body: string; cookie: string }>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: target.port,
        path: target.pathname + target.search,
        headers: { host: target.host, cookie, ...(origin ? { origin } : {}) },
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

test("ace start exposes a loopback preview that requires forwarding and paired operate authority", async ({
  onTestFinished,
}) => {
  const home = await mkdtemp(join(tmpdir(), "ace-smoke-preview-"));
  const cleanups: (() => Promise<void> | void)[] = [
    () => rm(home, { recursive: true, force: true }),
  ];
  onTestFinished(async () => {
    for (const close of cleanups.toReversed()) await close();
  });
  copyTlsFixture(home);
  const upstream = createServer((_req, res) => res.end("working CLI preview"));
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
  if (!address || typeof address === "string") throw new Error("Missing upstream port");
  await launchDaemon(
    {
      ...process.env,
      ACE_HOME: home,
      ACE_PORT: "0",
      ACE_LISTEN: "lan",
      ACE_ADVERTISE_HOST: "127.0.0.1",
      ACE_DEV: "1",
      PATH: "",
      ACE_LOG_LEVEL: "silent",
    },
    /Token file:/,
    cleanups,
  ).ready;
  const origin = await readFile(join(home, "daemon-endpoint"), "utf8");
  const token = await readFile(join(home, "daemon-token"), "utf8");
  const client = new Client(origin.replace("http:", "ws:"));
  cleanups.push(() => client.close());
  await once(client.socket, "open");
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("preview-smoke"),
    token,
  });
  await client.next();
  client.send({ type: "subscribe", subscriptionId: "threads", scope: { kind: "threads" } });
  const snapshot = await client.next();
  const threads = z
    .object({ view: z.object({ threads: z.record(z.string(), z.object({ id: ThreadId })) }) })
    .parse(snapshot);
  const thread = Object.values(threads.view.threads)[0];
  if (!thread) throw new Error("Missing development thread");
  const path = `/v1/previews/${address.port}/link`;
  const pairing = PairingResponse.parse(
    await accessRequest(origin, "/v1/pairings", {
      method: "POST",
      token,
      body: { scopes: ["read", "operate"] },
    }),
  );
  const paired = await redeemPairing(pairing.url, "Preview operator");
  await expect(
    accessRequest(origin, path, { method: "POST", token: paired.token }),
  ).rejects.toThrow();
  client.send({
    type: "preview.request",
    requestId: "forward",
    threadId: thread.id,
    operation: { op: "forward", port: address.port },
  });
  const forwarded = await client.next();
  expect(forwarded).toMatchObject({ type: "preview.result", ok: true });
  await expect(accessRequest(origin, path, { method: "POST", token })).rejects.toThrow("HTTP 403");
  const link = await accessRequest(origin, path, { method: "POST", token: paired.token });
  const url = PairingResponse.pick({ url: true }).parse(link).url;
  expect(new URL(url).hostname).toMatch(/\.preview\.localhost$/);
  expect((await get(new URL(url).origin)).status).toBe(401);
  const login = await get(url);
  expect(login.status).toBe(303);
  expect((await get(new URL(url).origin, login.cookie)).body).toBe("working CLI preview");
  expect((await get(new URL(url).origin, login.cookie, "https://foreign.example")).status).toBe(
    403,
  );
});
