import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { BrowserContext } from "@playwright/test";
import { z } from "zod";
import { startBenchDaemon } from "@ace/perf-kit/daemon";
import { bunBinary } from "../../../scripts/runtimes.ts";

/*
 * The slow-link run's `daemon` target: the bench daemon from apps/daemon/bench (a real daemon in
 * a temporary home, its threads replayed from recorded fixtures, no provider CLI), serving the
 * production web build from its TLS listener for paired devices, as a phone opening a pairing
 * link reaches it. The daemon serves apps/web/dist; it is built here when it is missing.
 */

const web = new URL("../../../apps/web/", import.meta.url).pathname;
const entry = new URL("../../../apps/daemon/bench/slow-link-daemon.ts", import.meta.url).pathname;

const Ready = z.object({
  endpoint: z.string(),
  token: z.string(),
  remoteUrl: z.string(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  threads: z.object({ typical: z.object({ id: z.string() }) }),
});
const Pairing = z.object({ url: z.string() });

/** What the page did, with SLOW_LINK_DEBUG=1, for a pairing that stalls. */
const log = (text: string) => process.stderr.write(`page: ${text}\n`);

export interface DaemonApp {
  /** The daemon's TLS listener, for the shaper to stand in front of. */
  origin: { host: string; port: number };
  /** Pairs `context` as a new phone, through `address` (the shaper), as the person would. */
  pair(context: BrowserContext, address: string): Promise<void>;
  /** The recorded typical thread's route. */
  threadPath: string;
  /**
   * Chromium's arguments to trust the daemon's own key, the pin a native client checks. Not
   * `--ignore-certificate-errors`: Chromium keeps nothing from a certificate-error connection
   * in its HTTP cache, which would make every warm visit cold.
   */
  browserArgs: string[];
}

export async function withDaemonApp<T>(run: (app: DaemonApp) => Promise<T>): Promise<T> {
  if (!existsSync(`${web}dist/index.html`))
    await promisify(execFile)("bunx", ["vite", "build"], {
      cwd: web,
      maxBuffer: 64 * 1024 * 1024,
    });
  const daemon = await startBenchDaemon({
    entry,
    execPath: bunBinary(),
    parse: (ready) => Ready.parse(ready),
  });
  try {
    const { ready } = daemon;
    const remote = new URL(ready.remoteUrl);
    return await run({
      origin: { host: remote.hostname, port: Number(remote.port) },
      threadPath: `/t/${ready.threads.typical.id}`,
      browserArgs: [
        `--ignore-certificate-errors-spki-list=${Buffer.from(ready.fingerprint, "hex").toString("base64")}`,
      ],
      async pair(context, address) {
        const local = ready.endpoint.replace("ws:", "http:");
        const response = await fetch(new URL("/v1/pairings", local), {
          method: "POST",
          headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" },
          body: JSON.stringify({ scopes: ["read", "operate"] }),
        });
        if (!response.ok) throw new Error(`Pairing code refused: HTTP ${response.status}`);
        const link = new URL(Pairing.parse(await response.json()).url);
        link.host = address;
        const page = await context.newPage();
        if (process.env.SLOW_LINK_DEBUG) {
          page.on("console", (message) => log(message.text()));
          page.on("requestfailed", (request) =>
            log(`failed ${request.url()} ${request.failure()?.errorText}`),
          );
          page.on("response", (answer) => {
            if (answer.status() >= 400) log(`${answer.status()} ${answer.url()}`);
          });
          page.on("websocket", (socket) => {
            log(`websocket ${socket.url()}`);
            socket.on("close", () => log("websocket closed"));
          });
        }
        try {
          await page.goto(link.href);
          // The form a person fills: a name, and remembered, so a new tab is still paired.
          await page.getByLabel("This device's name").fill("Slow link phone");
          await page.getByRole("switch", { name: "Remember on this device" }).check();
          await page.getByRole("button", { name: "Pair and connect" }).click();
          // Paired once the app leaves the pairing route for the daemon's own pages.
          await page
            .waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 120_000 })
            .catch(async (error: unknown) => {
              const shown = (
                await page
                  .locator("body")
                  .innerText()
                  .catch(() => "")
              ).slice(0, 600);
              throw new Error(`Pairing did not finish at ${page.url()}; the page shows: ${shown}`, {
                cause: error,
              });
            });
        } finally {
          await page.close();
        }
      },
    });
  } finally {
    await daemon.close();
  }
}
