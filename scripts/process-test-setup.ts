import { execFile } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { findExecutable } from "@ace/provider-kit/discovery";
import { promisify } from "node:util";
import type { TestProject } from "vitest/node";
import { PROCESS_TEST_TIMEOUT } from "@ace/provider-kit/testing";
import { testHomeEnvironment } from "./test-home-environment.ts";
import type { TestHomeContext } from "./test-home-global-setup.ts";

declare module "vitest" {
  export interface ProvidedContext {
    machineWorker: string;
  }
}

const execute = promisify(execFile);

export default async function setup(project: TestProject) {
  const context: TestHomeContext = project.getProvidedContext();
  const directory = await mkdtemp(join(context.testHomeRoot, "ace-process-tests-"));
  const daemonCli = join(directory, "cli.mjs");
  const machineWorker = join(directory, "machine-worker.mjs");
  const tlsHome = join(directory, "identity");
  const tls = join(tlsHome, "tls");
  const gitTemplate = join(directory, "git-template");
  try {
    const env = testHomeEnvironment(
      join(directory, "home"),
      context.testRealHome,
      process.env,
      context.enclosingRepository?.checkouts,
    );
    // Windows ships no OpenSSL, but Git for Windows (which ace needs anyway) carries one.
    if (process.platform === "win32") await addGitOpenssl(env);
    // Bundle output lives outside the real home. Only dependency code resolves into the checkout.
    await symlink(
      join(project.config.root, "apps/daemon/node_modules"),
      join(directory, "node_modules"),
      "junction",
    );
    await mkdir(tls, { recursive: true, mode: 0o700 });
    // Build local CLI modules once per run. Keep package imports native so
    // runtime-relative CommonJS requires and worker URLs resolve beside their sources.
    const results = await Promise.allSettled([
      // The real machine workers run JavaScript, like production Vite workers. Node 26's
      // concurrent WASM TypeScript loader can SIGILL before/during lazy service imports.
      execute(
        "bun",
        [
          "build",
          "packages/client-worker/src/machines-worker.fixture.ts",
          "--target",
          "node",
          "--outfile",
          machineWorker,
        ],
        { cwd: project.config.root, env, timeout: PROCESS_TEST_TIMEOUT },
      ),
      execute(
        "bun",
        [
          "build",
          "apps/daemon/src/cli.ts",
          "--target",
          "node",
          "--packages",
          "external",
          "--outfile",
          daemonCli,
        ],
        { cwd: project.config.root, env, timeout: PROCESS_TEST_TIMEOUT },
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
        { env, timeout: PROCESS_TEST_TIMEOUT },
      ),
      execute("git", ["init", "-b", "main", gitTemplate], { env, timeout: PROCESS_TEST_TIMEOUT }),
    ]);
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason));
    await appendFile(
      join(gitTemplate, ".git/config"),
      "\n[user]\n\tname = Test\n\temail = test@example.invalid\n[commit]\n\tgpgsign = false\n",
    );
    await chmod(join(tls, "key.pem"), 0o600);
    project.provide("daemonCli", daemonCli);
    project.provide("machineWorker", machineWorker);
    project.provide("tlsHome", tlsHome);
    project.provide("gitTemplate", gitTemplate);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return () => rm(directory, { recursive: true, force: true });
}

/** Puts Git for Windows' openssl.exe on PATH when none is there, for the TLS fixture. */
async function addGitOpenssl(env: NodeJS.ProcessEnv): Promise<void> {
  if (await findExecutable("openssl", env, "win32")) return;
  const git = await findExecutable("git", env, "win32");
  if (!git) return;
  // `<Git>\cmd\git.exe` or `<Git>\bin\git.exe`; OpenSSL is in `<Git>\usr\bin`.
  const bin = join(dirname(dirname(git)), "usr", "bin");
  if (!existsSync(join(bin, "openssl.exe"))) return;
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  env[key] = `${env[key] ?? ""};${bin}`;
}
