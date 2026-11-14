import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonRuntime } from "./runtime.ts";

const token = "ab".repeat(32);
let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ace-early-connection-"));
});
afterEach(() => rm(home, { recursive: true, force: true }));

/** The app's runtime for a temp home whose daemon has not answered yet. */
function runtime(env: NodeJS.ProcessEnv = { ACE_PORT: "5151" }) {
  return new DaemonRuntime({
    target: { kind: "managed", home, entry: join(home, "unused.mjs") },
    packaged: false,
    version: "0.0.0",
    resources: { entry: join(home, "unused.mjs") },
    env: { SHELL: "/bin/sh", PATH: "/usr/bin:/bin", ...env },
    spawnDaemon: () => {
      throw new Error("No daemon runtime in this build");
    },
    log: () => {},
  });
}

async function keep(files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) await writeFile(join(home, name), text);
}

describe("the page's hand-off while the daemon starts", () => {
  it("is what the home kept, at the daemon's configured port, before the daemon answers", async () => {
    await keep({ "daemon-token": `${token}\n`, "host-id": "host-1" });
    expect(await runtime().earlyConnection()).toEqual({
      mode: "daemon",
      url: "ws://127.0.0.1:5151/",
      token,
      localHostId: "host-1",
    });
  });

  it("uses the address a daemon that did not shut down cleanly published", async () => {
    await keep({
      "daemon-token": token,
      "host-id": "host-1",
      "daemon-endpoint": "http://127.0.0.1:6161",
    });
    expect((await runtime().earlyConnection())?.url).toBe("ws://127.0.0.1:6161/");
  });

  it("is nothing on a first start, which has no identity yet and nothing cached", async () => {
    await keep({ "daemon-token": token });
    expect(await runtime().earlyConnection()).toBeUndefined();
  });

  it("is nothing when the daemon takes any free port, so no address can be guessed", async () => {
    await keep({ "daemon-token": token, "host-id": "host-1" });
    expect(await runtime({ ACE_PORT: "0" }).earlyConnection()).toBeUndefined();
  });

  it("is nothing once the start failed, so the page shows the failure instead", async () => {
    await keep({ "daemon-token": token, "host-id": "host-1" });
    const app = runtime();
    await app.start();
    expect(app.current().state).toBe("failed");
    expect(await app.earlyConnection()).toBeUndefined();
    await expect(app.connection()).rejects.toThrow("No daemon runtime");
  });
});
