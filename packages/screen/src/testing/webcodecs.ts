import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/*
 * Real WebCodecs: H.264 units decoded by a headless Chromium's `VideoDecoder`, the decoder
 * the web client uses, driven over the DevTools protocol. Test support only.
 */

const Version = z.object({ webSocketDebuggerUrl: z.string() });
const Targets = z.array(
  z.object({ type: z.string(), url: z.string(), webSocketDebuggerUrl: z.string() }),
);
const Evaluated = z.object({
  id: z.literal(1),
  result: z.object({
    result: z.object({ value: z.unknown() }),
    exceptionDetails: z.unknown().optional(),
  }),
});
const Decoded = z.object({
  decoded: z.number(),
  width: z.number(),
  height: z.number(),
  errors: z.array(z.string()),
});
export type Decoded = z.infer<typeof Decoded>;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Decodes `units` (Annex B, the first a keyframe) as `codec`; reports what came out. */
export async function decodeInChromium(
  executable: string,
  codec: string,
  units: { payload: Uint8Array; keyframe: boolean }[],
): Promise<Decoded> {
  const profile = mkdtempSync(join(tmpdir(), "ace-webcodecs-"));
  // WebCodecs needs a secure context: a loopback page is one, `about:blank` may not be.
  const server = createServer((_, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>webcodecs</title>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback page");
  const page = `http://127.0.0.1:${address.port}/`;
  const chrome = spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Loopback is a secure context by the spec; some Chromium builds want it said.
      `--unsafely-treat-insecure-origin-as-secure=${page.slice(0, -1)}`,
      page,
    ],
    { stdio: "ignore" },
  );
  let port: string | undefined;
  try {
    for (let waited = 0; !port && waited < 20_000; waited += 100) {
      await pause(100);
      try {
        port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
      } catch {
        // Not written yet.
      }
    }
    if (!port) throw new Error("Chromium did not open DevTools");
    let target: z.infer<typeof Targets>[number] | undefined;
    for (let waited = 0; !target && waited < 20_000; waited += 100) {
      const targets = Targets.parse(
        await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(),
      );
      target = targets.find((entry) => entry.type === "page" && entry.url === page);
      if (!target) await pause(100);
    }
    if (!target) throw new Error("No page target");
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const chunks = units.map((unit) => ({
      key: unit.keyframe,
      data: Buffer.from(unit.payload).toString("base64"),
    }));
    const expression = `(async () => {
      const chunks = ${JSON.stringify(chunks)};
      const errors = [];
      let decoded = 0, width = 0, height = 0;
      if (typeof VideoDecoder === "undefined")
        return { decoded, width, height, errors: ["no VideoDecoder (secure context: " + isSecureContext + ", " + location.href + ", " + navigator.userAgent + ")"] };
      const decoder = new VideoDecoder({
        output: (frame) => { decoded++; width = frame.codedWidth; height = frame.codedHeight; frame.close(); },
        error: (error) => errors.push(String(error)),
      });
      decoder.configure({ codec: ${JSON.stringify(codec)}, optimizeForLatency: true });
      chunks.forEach((chunk, index) => decoder.decode(new EncodedVideoChunk({
        type: chunk.key ? "key" : "delta", timestamp: index * 16666,
        data: Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0)) })));
      await decoder.flush().catch((error) => errors.push(String(error)));
      return { decoded, width, height, errors };
    })()`;
    const reply = new Promise<unknown>((resolve, reject) => {
      socket.addEventListener("message", (message) => resolve(JSON.parse(String(message.data))), {
        once: true,
      });
      socket.addEventListener("error", reject, { once: true });
    });
    socket.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
    const evaluated = Evaluated.parse(await reply);
    socket.close();
    if (evaluated.result.exceptionDetails)
      throw new Error(`WebCodecs threw: ${JSON.stringify(evaluated.result.exceptionDetails)}`);
    return Decoded.parse(evaluated.result.result.value);
  } finally {
    const exited = new Promise((resolve) =>
      chrome.exitCode !== null ? resolve(null) : chrome.once("exit", resolve),
    );
    // Closing over DevTools ends every Chromium process, so the profile is free to delete.
    if (port) await closeBrowser(port).catch(() => {});
    const timer = setTimeout(() => chrome.kill(), 5_000);
    await exited;
    clearTimeout(timer);
    server.close();
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch {
      // A helper process may hold a file a moment longer; the temp folder is the test's own.
    }
  }
}

async function closeBrowser(port: string): Promise<void> {
  const version = Version.parse(
    await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(),
  );
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
}
