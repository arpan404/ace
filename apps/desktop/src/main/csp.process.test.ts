import { readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:https";
import { chromium } from "playwright-core";
import { expect, inject, it } from "vitest";
import { contentSecurityPolicy } from "./csp.ts";

declare module "vitest" {
  export interface ProvidedContext {
    chromiumExecutable: string;
  }
}

it("allows HTTPS ticket requests alongside the selected WSS daemon", async () => {
  const server = createServer(
    {
      cert: await readFile(
        new URL("../../../../packages/preview/src/testing/cert.pem", import.meta.url),
      ),
      key: await readFile(
        new URL("../../../../packages/preview/src/testing/key.pem", import.meta.url),
      ),
    },
    (_request, response) => {
      response.writeHead(200, {
        "access-control-allow-origin": "*",
        "content-type": "application/json",
      });
      response.end('{"ticket":"chosen-daemon"}');
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TLS listener");
  const browser = await chromium.launch({
    executablePath: inject("chromiumExecutable"),
    headless: true,
    args: ["--host-resolver-rules=MAP selected.ace.test 127.0.0.1", "--no-proxy-server"],
  });
  try {
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    const policy = contentSecurityPolicy({
      daemonOrigins: [`wss://selected.ace.test:${address.port}`],
      dev: { origin: "http://localhost:5173" },
    });
    await page.setContent(`<meta http-equiv="Content-Security-Policy" content="${policy}">`);
    const result = await page.evaluate(async (origin) => {
      try {
        return await (await fetch(`${origin}/v1/tickets`)).json();
      } catch {
        return "blocked";
      }
    }, `https://selected.ace.test:${address.port}`);
    expect(result).toEqual({ ticket: "chosen-daemon" });
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("loads a Suit's bundled font from the local daemon, by suit.css and by FontFace", async () => {
  // The daemon serves Suit assets from its own loopback origin, with CORS for the app.
  const font = await readFile(
    new URL(
      "../../../../packages/plugins/builtin-suits/loam/assets/fonts/PixelifySans.woff2",
      import.meta.url,
    ),
  );
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { "access-control-allow-origin": "*", "content-type": "font/woff2" });
    response.end(font);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  const browser = await chromium.launch({
    executablePath: inject("chromiumExecutable"),
    headless: true,
    args: ["--no-proxy-server"],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy({})}">`,
    );
    const loaded = await page.evaluate(async (url) => {
      // suit.css's way: an @font-face rule in the Suit's sheet.
      const style = document.createElement("style");
      style.textContent = `@font-face{font-family:"Sheet Face";src:url("${url}") format("woff2")}`;
      document.head.append(style);
      const sheet = await document.fonts.load('16px "Sheet Face"').then(
        (faces) => faces.length > 0,
        () => false,
      );
      // suit.json's way: the FontFace API.
      const api = await new FontFace("Api Face", `url("${url}?api") format("woff2")`).load().then(
        () => true,
        () => false,
      );
      return { sheet, api };
    }, `http://127.0.0.1:${address.port}/v1/suits/loam/font.woff2`);
    expect(loaded).toEqual({ sheet: true, api: true });
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
