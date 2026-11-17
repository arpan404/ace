import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { prepareDaemonHome } from "@ace/service";
import { startDaemon, readConfig } from "@ace/daemon";

// A process test: a provider CLI that never answers is a real child process the daemon spawns
// on its way up, and what matters is that the real daemon publishes its endpoint regardless.
test("the daemon listens while a provider CLI never answers, its engine still starting", async ({
  onTestFinished,
}) => {
  const home = await mkdtemp(join(tmpdir(), "ace-engine-startup-"));
  prepareDaemonHome(home);
  vi.stubEnv("PATH", home);
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  onTestFinished(async () => {
    vi.unstubAllEnvs();
    await daemon?.close();
    await rm(home, { recursive: true, force: true });
  });
  // `claude --version` and `claude auth status` both hang, as a CLI on a stuck disk does.
  await writeFile(join(home, "claude"), "#!/bin/sh\nexec /bin/sleep 60\n", { mode: 0o700 });

  const started = performance.now();
  daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    toolkits: [],
    engine: {
      cursor: {
        discovery: {
          resolve() {
            throw Object.assign(new Error("No SDK in fixture"), { code: "MODULE_NOT_FOUND" });
          },
        },
      },
    },
    history: { instances: [] },
  });
  // The version probe alone waits 10 s before it gives up; the endpoint does not wait for it.
  expect(performance.now() - started).toBeLessThan(8_000);
  expect(existsSync(join(home, "daemon-endpoint"))).toBe(true);
  expect(daemon.serviceStatus().find((service) => service.name === "engine")).toEqual({
    name: "engine",
    state: "starting",
  });
});
