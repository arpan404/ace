import { execFile } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TestProject } from "vitest/node";
import { PROCESS_TEST_TIMEOUT } from "@ace/provider-kit/testing";

const execute = promisify(execFile);

export default async function setup(project: TestProject) {
  // External dependencies resolve through the daemon's workspace node_modules.
  const cache = join(project.config.root, "apps/daemon/node_modules/.cache");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, "ace-process-tests-"));
  const daemonCli = join(directory, "cli.mjs");
  const tlsHome = join(directory, "identity");
  const tls = join(tlsHome, "tls");
  const gitTemplate = join(directory, "git-template");
  try {
    await mkdir(tls, { recursive: true, mode: 0o700 });
    // Build once per run, never per spawn. Keep notify external so its worker
    // entry URL still resolves to the real worker-entry.ts beside worker.ts.
    // MCP's jsonc-parser uses runtime-relative UMD requires; keep them native.
    // Main's model catalog also resolves a storage worker beside its source.
    const results = await Promise.allSettled([
      execute(
        "bun",
        [
          "build",
          "apps/daemon/src/cli.ts",
          "--target",
          "node",
          "--external",
          "ws",
          "--external",
          "@ace/notify",
          "--external",
          "@ace/mcp-server",
          "--external",
          "@ace/models",
          "--external",
          "@ace/commands",
          "--outfile",
          daemonCli,
        ],
        { cwd: project.config.root, timeout: PROCESS_TEST_TIMEOUT },
      ),
      execute(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-sha256",
          "-days",
          "3650",
          "-subj",
          "/CN=ace",
          "-keyout",
          join(tls, "key.pem"),
          "-out",
          join(tls, "cert.pem"),
        ],
        { timeout: PROCESS_TEST_TIMEOUT },
      ),
      execute("git", ["init", "-b", "main", gitTemplate], { timeout: PROCESS_TEST_TIMEOUT }),
    ]);
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason));
    await appendFile(
      join(gitTemplate, ".git/config"),
      "\n[user]\n\tname = Test\n\temail = test@example.invalid\n[commit]\n\tgpgsign = false\n",
    );
    await chmod(join(tls, "key.pem"), 0o600);
    project.provide("daemonCli", daemonCli);
    project.provide("tlsHome", tlsHome);
    project.provide("gitTemplate", gitTemplate);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return () => rm(directory, { recursive: true, force: true });
}
