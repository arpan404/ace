import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { _electron as electron } from "playwright-core";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { appEnvironment, desktop, electronBinary } from "../scripts/common.ts";

const enabled = process.env.ACE_E2E_ELECTRON === "1";

async function daemon(label: string) {
  const server = createServer(
    {
      cert: await readFile(join(desktop, "../../packages/preview/src/testing/cert.pem")),
      key: await readFile(join(desktop, "../../packages/preview/src/testing/key.pem")),
    },
    (_request, response) => {
      response.setHeader("access-control-allow-origin", "*");
      response.end(`${label} data`);
    },
  );
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => socket.send(`${label} socket`));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing daemon address");
  return {
    origin: `https://127.0.0.1:${address.port}/`,
    close: async () => {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

it.skipIf(!enabled)(
  "a worker reaches a dynamically selected HTTPS/WSS daemon while other origins stay blocked in production Electron",
  async () => {
    const out = await mkdtemp(join(tmpdir(), "ace-e2e-network-"));
    const selected = await daemon("Selected");
    const other = await daemon("Other");
    try {
      await build({
        entryPoints: [join(desktop, "e2e/fixtures/daemon-network-main.ts")],
        outfile: join(out, "main.mjs"),
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node24",
        external: ["electron"],
        banner: {
          js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
        },
      });
      await build({
        entryPoints: [join(desktop, "src/preload/index.ts")],
        outfile: join(out, "preload.cjs"),
        bundle: true,
        format: "cjs",
        platform: "browser",
        external: ["electron"],
      });
      await build({
        entryPoints: [join(desktop, "e2e/fixtures/daemon-network-renderer.ts")],
        outfile: join(out, "renderer.js"),
        bundle: true,
        format: "esm",
        platform: "browser",
      });
      await writeFile(
        join(out, "index.html"),
        '<!doctype html><html><body><output role="status">Ready</output><script type="module" src="/renderer.js"></script></body></html>',
      );
      await writeFile(
        join(out, "worker.js"),
        `
      onmessage = async ({ data: origin }) => {
        try {
          const data = await (await fetch(origin)).text();
          const message = await new Promise((resolve, reject) => {
            const socket = new WebSocket(origin.replace(/^https:/, "wss:"));
            socket.onmessage = (event) => { socket.close(); resolve(event.data); };
            socket.onerror = () => { socket.close(); reject(new Error("Blocked socket")); };
          });
          postMessage(data + " / " + message);
        } catch { postMessage("Blocked"); }
      };
    `,
      );
      const app = await electron.launch({
        executablePath: await electronBinary(),
        args: [join(out, "main.mjs")],
        env: {
          ...appEnvironment(process.env),
          ACE_E2E_USER_DATA: join(out, "user-data"),
          ACE_E2E_ORIGINS: new URLSearchParams({
            selected: selected.origin,
            other: other.origin,
          }).toString(),
        },
      });
      try {
        const page = await app.firstWindow();
        const status = page.getByRole("status");
        await page.getByRole("button", { name: "Probe selected" }).click();
        await expect.poll(() => status.textContent()).toBe("Blocked");
        await page.getByRole("button", { name: "Select daemon" }).click();
        await expect.poll(() => status.textContent()).toBe("Selected");
        await page.getByRole("button", { name: "Probe selected" }).click();
        await expect.poll(() => status.textContent()).toBe("Selected data / Selected socket");
        await page.getByRole("button", { name: "Probe other" }).click();
        await expect.poll(() => status.textContent()).toBe("Blocked");
      } finally {
        await app.close();
      }
    } finally {
      await selected.close();
      await other.close();
      await rm(out, { recursive: true, force: true });
    }
  },
);
