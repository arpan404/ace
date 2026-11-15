import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/*
 * Real WebCodecs: H.264 units decoded by a headless Chromium's `VideoDecoder`, the decoder
 * the web client uses, driven over the DevTools protocol. Test support only.
 */

const Version = z.object({ webSocketDebuggerUrl: z.string() });
const Targets = z.array(z.object({ type: z.string(), webSocketDebuggerUrl: z.string() }));
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
  const chrome = spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
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
    const targets = Targets.parse(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
    const page = targets.find((target) => target.type === "page");
    if (!page) throw new Error("No page target");
    const socket = new WebSocket(page.webSocketDebuggerUrl);
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
    chrome.kill();
    await new Promise((resolve) =>
      chrome.exitCode !== null ? resolve(null) : chrome.once("exit", resolve),
    );
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
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
