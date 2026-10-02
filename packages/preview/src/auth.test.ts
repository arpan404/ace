import { afterEach, expect, test } from "vitest";
import { CookieJar } from "tough-cookie";
import { http, serve, gateway, websocket } from "./test-support.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .toReversed()
      .map((f) => f()),
  );
});

test("links require pairing, expire, and can establish a session only once", async () => {
  let now = 10_000;
  const upstream = await serve((_req, res) => res.end("app"));
  cleanup.push(upstream.close);
  const g = await gateway({ now: () => now });
  cleanup.push(g.close);
  const origin = g.register({ port: upstream.port });
  await expect(g.mintLink({ port: upstream.port, deviceToken: "attacker" })).rejects.toThrow(
    "Paired device",
  );
  const { url, cookie, res } = await g.login(upstream.port);
  expect(res.status).toBe(303);
  expect(res.headers["set-cookie"]?.[0]).toContain("HttpOnly; SameSite=Lax");
  expect(res.headers.location).toBe("/");
  expect((await http(origin, { cookie })).body).toBe("app");
  expect((await http(url)).status).toBe(401);
  const expiring = await g.mintLink({ port: upstream.port, deviceToken: "paired-token" });
  now += 60_001;
  expect((await http(expiring)).status).toBe(401);
  now += 3_600_000;
  expect((await http(origin, { cookie })).status).toBe(401);
});

test("two forwarded ports keep same-named cookies and gateway sessions isolated", async () => {
  const one = await serve((req, res) => {
    if (req.url === "/set")
      res.setHeader("set-cookie", [
        "app=one; Domain=localhost; Path=/",
        "ace_preview_session=spoof; Path=/",
        "ace_preview_session = spoof; Path=/",
      ]);
    res.end(req.headers.cookie ?? "");
  });
  cleanup.push(one.close);
  const two = await serve((req, res) => {
    if (req.url === "/set") res.setHeader("set-cookie", "app=two; Path=/");
    res.end(req.headers.cookie ?? "");
  });
  cleanup.push(two.close);
  const g = await gateway();
  cleanup.push(g.close);
  const origins = [g.register({ port: one.port }), g.register({ port: two.port })];
  const jar = new CookieJar();
  for (const [index, port] of [one.port, two.port].entries()) {
    const origin = origins[index] ?? "";
    const login = await g.login(port);
    for (const cookie of login.res.headers["set-cookie"] ?? []) jar.setCookieSync(cookie, origin);
    const set = await http(`${origin}/set`, { cookie: jar.getCookieStringSync(origin) });
    expect(set.headers["set-cookie"]?.every((c) => !c.includes("Domain="))).toBe(true);
    for (const cookie of set.headers["set-cookie"] ?? []) jar.setCookieSync(cookie, origin);
  }
  const first = origins[0] ?? "",
    second = origins[1] ?? "";
  expect((await http(first, { cookie: jar.getCookieStringSync(first) })).body.trim()).toBe(
    "app=one",
  );
  expect((await http(second, { cookie: jar.getCookieStringSync(second) })).body.trim()).toBe(
    "app=two",
  );
  expect((await http(second, { cookie: jar.getCookieStringSync(first) })).status).toBe(401);
});

test("forged Host, Origin, session signatures and upgrades cannot bypass authentication", async () => {
  let hits = 0;
  const upstream = await serve((_req, res) => {
    hits++;
    res.end("secret");
  });
  cleanup.push(upstream.close);
  const g = await gateway();
  cleanup.push(g.close);
  const origin = g.register({ port: upstream.port });
  const { cookie } = await g.login(upstream.port);
  expect((await http(origin)).status).toBe(401);
  expect((await http(origin, { cookie: `${cookie}x` })).status).toBe(401);
  expect((await http(origin, { host: `evil.test:${g.port}`, cookie })).status).toBe(403);
  expect((await http(origin, { origin: "http://evil.test", cookie })).status).toBe(403);
  await expect(websocket(origin, "")).rejects.toThrow();
  expect(hits).toBe(0);
});

test("outstanding links and registrations stop at their configured caps", async () => {
  let now = 1000;
  const upstream = await serve((_req, res) => res.end());
  cleanup.push(upstream.close);
  const g = await gateway({ now: () => now, limits: { links: 1, registrations: 1 } });
  cleanup.push(g.close);
  g.register({ port: upstream.port });
  expect(() => g.register({ port: upstream.port === 65535 ? 3000 : upstream.port + 1 })).toThrow(
    "Too many previews",
  );
  await g.mintLink({ port: upstream.port, deviceToken: "paired-token" });
  await expect(g.mintLink({ port: upstream.port, deviceToken: "paired-token" })).rejects.toThrow(
    "outstanding",
  );
  now += 60_001;
  expect((await g.login(upstream.port)).res.status).toBe(303);
});

test("revocation also rejects authentication that was already awaiting pairing lookup", async () => {
  const { createPreviewGateway } = await import("./index.ts");
  let gate = false;
  let release: (() => void) | undefined, started: (() => void) | undefined;
  const wait = new Promise<void>((done) => {
    release = done;
  });
  const checking = new Promise<void>((done) => {
    started = done;
  });
  let hits = 0;
  const upstream = await serve((_req, res) => {
    hits++;
    res.end("secret");
  });
  cleanup.push(upstream.close);
  const g = await createPreviewGateway({
    host: "127.0.0.1",
    wildcardHost: "preview.test",
    authority: {
      authorize: async () => "device",
      isPaired: async () => {
        if (gate) {
          started?.();
          await wait;
        }
        return true;
      },
    },
  });
  cleanup.push(g.close);
  const origin = g.register({ port: upstream.port });
  const login = await http(await g.mintLink({ port: upstream.port, deviceToken: "device-token" }));
  const cookie = login.headers["set-cookie"]?.[0]?.split(";")[0] ?? "";
  gate = true;
  const pending = http(origin, { cookie });
  await checking;
  g.revokeDevice("device");
  release?.();
  expect((await pending).status).toBe(401);
  expect(hits).toBe(0);
});

test("HTTPS links set a host-only Secure cookie and forward through a real TLS listener", async () => {
  const { readFile } = await import("node:fs/promises");
  const { request: httpsRequest } = await import("node:https");
  const { createPreviewGateway } = await import("./index.ts");
  const upstream = await serve((_req, res) => res.end("secure app"));
  cleanup.push(upstream.close);
  const g = await createPreviewGateway({
    host: "127.0.0.1",
    wildcardHost: "preview.test",
    authority: {
      authorize: async () => "device",
      isPaired: async () => true,
    },
    tls: {
      key: await readFile(new URL("./testing/key.pem", import.meta.url)),
      cert: await readFile(new URL("./testing/cert.pem", import.meta.url)),
    },
  });
  cleanup.push(g.close);
  const origin = g.register({ port: upstream.port });
  const get = async (url: string, cookie = "") =>
    new Promise<import("./test-support.ts").HttpResult>((resolve, reject) => {
      const address = new URL(url);
      const req = httpsRequest(
        {
          hostname: "127.0.0.1",
          port: g.port,
          path: address.pathname + address.search,
          headers: { host: address.host, cookie },
          rejectUnauthorized: false,
          agent: false,
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            body += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end();
    });
  const login = await get(await g.mintLink({ port: upstream.port, deviceToken: "device-token" }));
  const setCookie = login.headers["set-cookie"]?.[0] ?? "";
  expect(setCookie).toMatch(/^__Host-ace_preview_session=/);
  expect(setCookie).toContain("; Secure");
  const jar = new CookieJar();
  jar.setCookieSync(setCookie, origin);
  expect((await get(origin, jar.getCookieStringSync(origin))).body).toBe("secure app");
  expect(jar.getCookieStringSync(origin.replace("https:", "http:"))).toBe("");
});
