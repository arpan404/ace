import { createServer } from "node:net";
import { once } from "node:events";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { portAvailable, createSystemProbes, createDoctorChecks, runDoctor } from "./index.ts";
import { temporary } from "./test-support.ts";
it("port probing distinguishes an occupied loopback port and releases its own listener", async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  expect(await portAvailable(address.port, AbortSignal.timeout(5000))).toBe(false);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  expect(await portAvailable(address.port, AbortSignal.timeout(5000))).toBe(true);
  expect(await portAvailable(address.port, AbortSignal.timeout(5000))).toBe(true);
  await expect(portAvailable(address.port, AbortSignal.abort())).rejects.toThrow("Aborted");
});
it("system discovery uses only version and login-status commands on fake provider CLIs", async () => {
  const root = await temporary(),
    bin = join(root, "bin"),
    dataDir = join(root, "data");
  await mkdir(bin);
  await mkdir(dataDir);
  const script =
    '#!/bin/sh\ncase "$*" in\n"--version") echo "1.2.3";;\n"login status") echo "Logged in using ChatGPT";;\n*) exit 99;;\nesac\n';
  await writeFile(join(bin, "codex"), script);
  await chmod(join(bin, "codex"), 0o700);
  const probes = createSystemProbes({
    dataDir,
    port: 0,
    env: { PATH: bin, ACE_CHROMIUM: join(bin, "codex") },
  });
  const report = await runDoctor(createDoctorChecks(probes), { now: () => 0 });
  expect(report.checks.find((check) => check.id === "provider.codex")?.status).toBe("ok");
  expect(report.checks.find((check) => check.id === "git")?.status).toBe("fail");
  expect(report.checks.find((check) => check.id === "chromium")?.status).toBe("ok");
  expect(report.checks.find((check) => check.id === "disk")?.status).toBe("ok");
});
