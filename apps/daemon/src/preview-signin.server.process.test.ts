import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import { DeviceId, ThreadId, type PreviewRequest, type PreviewResult } from "@ace/protocol";
import { expect, test } from "vitest";
import { createDevThread } from "./commands.ts";
import { startDaemon, readConfig } from "./index.ts";
import { PreviewClient } from "./preview-client.ts";
import { cleanups, setup } from "./remote-test-support.ts";
import { Client, token } from "./socket-test-support.ts";

const previewOptions = { host: "127.0.0.1", wildcardHost: "preview.test" };
type Reply = { status: number; headers: IncomingHttpHeaders; body: string };

/** A browser-like GET: Host is the preview's own name, Sec-Fetch-Mode says how it was asked. */
function get(url: string, headers: Record<string, string> = {}): Promise<Reply> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: target.port,
        path: target.pathname + target.search,
        headers: { host: target.host, ...headers },
        agent: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
/** The cookie a browser keeps for a framed preview (`ace_preview_embed`), as a request header. */
function embedded(reply: Reply): string {
  const cookie = reply.headers["set-cookie"]?.find((value) =>
    value.startsWith("ace_preview_embed="),
  );
  if (!cookie) throw new Error("No embedded session cookie");
  return cookie.split(";")[0] ?? "";
}
async function devServer(body: string) {
  const server = createServer((_req, res) => res.end(body));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing dev server address");
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return address.port;
}
/** A port nothing listens on. */
async function closedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
/** A daemon server with its preview gateway and the preview service bound to it. */
async function previewSetup() {
  const previews = new PreviewClient();
  const f = await setup({ preview: previewOptions, previewClient: previews });
  const gateway = f.server.preview;
  if (!gateway) throw new Error("Missing preview gateway");
  previews.bind(gateway);
  return f;
}
let requests = 0;
async function preview(
  client: Client,
  threadId: string,
  operation: PreviewRequest["operation"],
): Promise<PreviewResult> {
  const requestId = `preview-${++requests}`;
  client.send({
    type: "preview.request",
    requestId,
    threadId: ThreadId.parse(threadId),
    operation,
  });
  for (;;) {
    const message = await client.next();
    if (message.type === "preview.result" && message.requestId === requestId) return message;
  }
}

test("the desktop's host credential previews a forwarded dev server through the running daemon", async ({
  onTestFinished,
}) => {
  const home = await mkdtemp(join(tmpdir(), "ace-preview-signin-"));
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let client: Client | undefined;
  onTestFinished(async () => {
    try {
      await client?.close();
    } finally {
      await daemon?.close();
      await rm(home, { recursive: true, force: true });
    }
  });
  const port = await devServer("hello from the dev server");
  daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    toolkits: [],
    modelInstances: [],
    preview: previewOptions,
  });
  const thread = createDevThread(daemon.store, daemon.store.createWorkspace(home, "Preview"));
  client = new Client(daemon.url);
  await once(client.socket, "open");
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("desktop-window"),
    token: await readFile(daemon.tokenPath, "utf8"),
  });
  expect(await client.next()).toMatchObject({ type: "welcome" });

  const forwarded = await preview(client, thread.id, { op: "forward", port });
  const origin = forwarded.previews?.[0]?.origin ?? "";
  // Without signing in, the gateway refuses, and a framed page is told why.
  const refused = await get(origin, { "sec-fetch-mode": "navigate" });
  expect(refused.status).toBe(401);
  expect(refused.body).toContain('data-reason="signed_out"');

  const signIn = await preview(client, thread.id, { op: "link", port });
  expect(signIn).toMatchObject({ ok: true, link: { sessionMs: 3_600_000 } });
  const login = await get(signIn.link?.url ?? "", { "sec-fetch-mode": "navigate" });
  expect(login.status).toBe(303);
  expect(login.headers.location).toBe("/");
  // A cross-site frame keeps only a partitioned SameSite=None cookie; Lax serves top-level visits.
  expect(login.headers["set-cookie"]).toEqual([
    expect.stringMatching(/^ace_preview_session=[^;]+; .*SameSite=Lax/),
    expect.stringMatching(/^ace_preview_embed=[^;]+; .*SameSite=None; .*Secure; Partitioned$/),
  ]);
  const page = await get(origin, { cookie: embedded(login), "sec-fetch-mode": "navigate" });
  expect(page).toMatchObject({ status: 200, body: "hello from the dev server" });
  // Each link signs in once.
  const spent = await get(signIn.link?.url ?? "", { "sec-fetch-mode": "navigate" });
  expect(spent.status).toBe(401);
  expect(spent.body).toContain('data-reason="link_invalid"');
});

test("a background renewal sets fresh cookies without a redirect and outlives the first hour", async () => {
  const f = await previewSetup();
  const port = await devServer("still here");
  const client = await f.connect();
  expect(await client.next()).toMatchObject({ type: "welcome" });
  const origin = (await preview(client, f.thread.id, { op: "forward", port })).previews?.[0]
    ?.origin;
  if (!origin) throw new Error("Missing preview origin");
  const first = await preview(client, f.thread.id, { op: "link", port });
  const firstSession = embedded(await get(first.link?.url ?? "", { "sec-fetch-mode": "navigate" }));

  // Five minutes before the hour, the panel redeems a fresh link with a no-cors fetch.
  f.advance(55 * 60_000);
  const second = await preview(client, f.thread.id, { op: "link", port });
  const renewal = await get(second.link?.url ?? "", { "sec-fetch-mode": "no-cors" });
  expect(renewal.status).toBe(204);
  expect(renewal.headers.location).toBeUndefined();
  expect(renewal.body).toBe("");
  const renewed = embedded(renewal);

  f.advance(10 * 60_000);
  expect((await get(origin, { cookie: firstSession })).status).toBe(401);
  expect(await get(origin, { cookie: renewed })).toMatchObject({ status: 200, body: "still here" });
});

test("refused previews say why: the dev server is down, the port is not this thread's, the preview is gone", async () => {
  const f = await previewSetup();
  const port = await closedPort();
  const client = await f.connect();
  expect(await client.next()).toMatchObject({ type: "welcome" });
  const origin = (await preview(client, f.thread.id, { op: "forward", port })).previews?.[0]
    ?.origin;
  if (!origin) throw new Error("Missing preview origin");

  const signIn = await preview(client, f.thread.id, { op: "link", port });
  const session = embedded(await get(signIn.link?.url ?? "", { "sec-fetch-mode": "navigate" }));
  const down = await get(origin, { cookie: session, "sec-fetch-mode": "navigate" });
  expect(down.status).toBe(502);
  expect(down.body).toContain('data-reason="upstream_unavailable"');
  // Only navigations get the explaining page; the app's own requests keep a bare status.
  expect(await get(origin, { cookie: session, "sec-fetch-mode": "cors" })).toMatchObject({
    status: 502,
    body: "",
  });

  const other = createDevThread(f.store, f.workspace);
  expect(await preview(client, other.id, { op: "link", port })).toMatchObject({
    ok: false,
    error: "preview_not_found",
  });
  expect(await preview(client, other.id, { op: "forward", port })).toMatchObject({
    ok: false,
    error: "preview_owned_by_another_thread",
  });

  await preview(client, f.thread.id, { op: "unforward", port });
  const gone = await get(origin, { cookie: session, "sec-fetch-mode": "navigate" });
  expect(gone.status).toBe(403);
  expect(gone.body).toContain('data-reason="not_previewed"');
});

test("a paired device's preview session is its own: read-only devices get none, revocation ends it", async () => {
  const f = await previewSetup();
  const port = await devServer("paired app");
  const host = await f.connect();
  expect(await host.next()).toMatchObject({ type: "welcome" });
  const origin = (await preview(host, f.thread.id, { op: "forward", port })).previews?.[0]?.origin;
  if (!origin) throw new Error("Missing preview origin");

  const reader = await f.pair(["read"]);
  const readOnly = await f.connectTicket(reader.device.id, (await f.ticket(reader.token)).ticket);
  expect(await readOnly.next()).toMatchObject({ type: "welcome" });
  expect(await preview(readOnly, f.thread.id, { op: "link", port })).toMatchObject({
    ok: false,
    error: "forbidden",
  });

  const operator = await f.pair(["read", "operate"]);
  const phone = await f.connectTicket(operator.device.id, (await f.ticket(operator.token)).ticket);
  expect(await phone.next()).toMatchObject({ type: "welcome" });
  const signIn = await preview(phone, f.thread.id, { op: "link", port });
  const session = embedded(await get(signIn.link?.url ?? "", { "sec-fetch-mode": "navigate" }));
  expect((await get(origin, { cookie: session })).body).toBe("paired app");

  await f.request(`/v1/devices/${operator.device.id}`, {
    method: "DELETE",
    token,
  });
  const revoked = await get(origin, { cookie: session, "sec-fetch-mode": "navigate" });
  expect(revoked.status).toBe(401);
  expect(revoked.body).toContain('data-reason="session_expired"');
});
