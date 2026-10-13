import { once } from "node:events";
import { createServer as createTcpServer, type Socket } from "node:net";
import { expect, test } from "vitest";
import { localSite } from "../icons/local-site.ts";
import { pageTitle, probePage } from "./page-probe.ts";

test("a dev server's page title and declared icon come back over loopback", async () => {
  const site = await localSite({
    "/": {
      html: '<!doctype html><head><title>\n  Vite &amp; React &#8212; TS\n</title><link rel="icon" href="/vite.svg"></head>',
    },
    "/vite.svg": Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#646cff"/></svg>',
    ),
  });
  try {
    const page = await probePage(site.port);
    expect(page).toMatchObject({ http: true, title: "Vite & React — TS" });
    expect(page.iconUrl).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
  } finally {
    await site.close();
  }
});

test("a server that answers HTTP without a page is still a server, without a title", async () => {
  const site = await localSite({});
  try {
    expect(await probePage(site.port)).toEqual({ http: true });
  } finally {
    await site.close();
  }
});

test("a listener that doesn't speak HTTP is not a dev server", async () => {
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.end("\x00\x01not http\r\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  try {
    expect(await probePage(address.port, 1000)).toEqual({ http: false });
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
  }
});

test("page titles ignore markup around them and stay short", () => {
  expect(pageTitle("<html><title data-x='1'>Next.js</title></html>")).toBe("Next.js");
  expect(pageTitle("<title>   </title>")).toBeUndefined();
  expect(pageTitle("<p>no title</p>")).toBeUndefined();
  expect(pageTitle(`<title>${"a".repeat(500)}</title>`)).toHaveLength(200);
});
