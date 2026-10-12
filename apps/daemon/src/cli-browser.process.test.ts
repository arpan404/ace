import { EventEmitter } from "node:events";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserBackend } from "@ace/browser";
import { expect, test } from "vitest";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { invoke } from "./cli-test-support.ts";

test("browser CLI captures through the shared owner and downloads a private artifact without overwriting files", async () => {
  const events = new EventEmitter();
  const bytes = Buffer.from("synthetic image bytes");
  const backend: BrowserBackend = {
    kind: "headless",
    async open(request) {
      let url = "about:blank";
      return {
        cdp: {
          send: async (method) =>
            method === "Page.captureScreenshot" ? { data: bytes.toString("base64") } : {},
          on: (method, listener) => events.on(method, listener),
          off: (method, listener) => events.off(method, listener),
        },
        url: () => url,
        navigate: async (destination) => {
          url = destination;
          request.navigation();
        },
        click: async () => {},
        insertText: async () => {},
        press: async () => {},
        wheel: async () => {},
        screenshot: async () => bytes,
        resize: async () => {},
        viewport: () => ({ width: 1280, height: 720 }),
        media: async () => {},
        controller: async () => {},
        close: async () => {},
      };
    },
  };
  const f = await daemonFixture(undefined, {
    browser: {
      headlessBackend: backend,
      backendPreference: async (): Promise<"headless"> => "headless",
    },
  });
  try {
    const output = join(f.h.home, "capture.png");
    const result = await invoke(join(f.h.home, "daemon"), [
      "browser",
      "shot",
      f.caller.threadId,
      "--output",
      output,
      "--json",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      path: output,
      mimeType: "image/png",
      artifactId: expect.any(String),
    });
    expect(await readFile(output)).toEqual(bytes);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    const transcript = await invoke(join(f.h.home, "daemon"), [
      "thread",
      "read",
      f.caller.threadId,
      "--json",
    ]);
    expect(JSON.parse(transcript.stdout).items).toContainEqual(
      expect.objectContaining({
        type: "artifact",
        source: "browser",
        artifactId: JSON.parse(result.stdout).artifactId,
      }),
    );
    await writeFile(output, "keep this file");
    const repeated = await invoke(join(f.h.home, "daemon"), [
      "browser",
      "shot",
      f.caller.threadId,
      "--output",
      output,
      "--json",
    ]);
    expect(repeated.code).toBe(4);
    expect(await readFile(output, "utf8")).toBe("keep this file");
  } finally {
    await f.daemon.close();
  }
});
