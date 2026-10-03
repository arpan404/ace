import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));

// Requires an explicitly provisioned Docker host at merge, never a provider CLI.
it.skipIf(process.env.ACE_RELAY_DOCKER_TEST !== "1")(
  "installs the relay image independently of workspace's native build and exchanges encrypted messages",
  async () => {
    await execute("docker", ["build", "-f", "apps/relay/Dockerfile", "-t", "ace-relay:test", "."], {
      cwd: root,
    });
    const result = await execute(process.execPath, ["apps/relay/bench/docker-smoke.ts"], {
      cwd: root,
    });
    expect(result.stdout).toContain("Docker Node 24 encrypted host/client round trip passed");
  },
);
