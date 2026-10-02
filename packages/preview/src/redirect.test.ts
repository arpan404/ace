import { afterEach, expect, test } from "vitest";
import { attachPreviewRelay, openPreviewProxy } from "./index.ts";
import { serve, http, gateway, channelPair } from "./test-support.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

test.each(["gateway", "relay"])(
  "%s keeps browser-normalized loopback authority redirects on the preview origin",
  async (kind) => {
    const upstream = await serve((req, res) => {
      const authority = req.url?.slice(1) ?? "localhost";
      const separator = req.headers["x-redirect-separator"] ?? "//";
      const location =
        authority === "relative"
          ? "/next?q=1#fragment"
          : `${separator}${authority}:${upstream.port}/next?q=1#fragment`;
      res.writeHead(302, { location });
      res.end();
    });
    cleanup.push(upstream.close);
    let origin: string,
      cookie = "";
    if (kind === "gateway") {
      const g = await gateway();
      cleanup.push(g.close);
      origin = g.register({ port: upstream.port });
      cookie = (await g.login(upstream.port)).cookie;
    } else {
      const channels = channelPair();
      const host = attachPreviewRelay({
        channel: channels.b,
        allowPort: async (p) => p === upstream.port,
      });
      cleanup.push(host.close);
      const proxy = await openPreviewProxy({ channel: channels.a, port: upstream.port });
      cleanup.push(proxy.close);
      origin = proxy.url;
    }
    for (const separator of ["//", "\\\\", "/\\", "\\/"]) {
      for (const authority of ["localhost", "127.0.0.1", "[::1]"]) {
        const response = await http(`${origin}/${authority}`, {
          cookie,
          "x-redirect-separator": separator,
        });
        expect(response.status).toBe(302);
        expect(response.headers.location).toBe(`${origin}/next?q=1#fragment`);
      }
    }
    expect((await http(`${origin}/relative`, { cookie })).headers.location).toBe(
      "/next?q=1#fragment",
    );
    expect((await http(`${origin}/example.com`, { cookie })).headers.location).toBe(
      `//example.com:${upstream.port}/next?q=1#fragment`,
    );
  },
);
