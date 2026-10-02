import { createServer } from "node:net";
import { once } from "node:events";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { portAvailable, createSystemProbes, createDoctorChecks, runDoctor } from "./index.ts";
import { temporary, systemProbeRuntime } from "./test-support.ts";
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
  const probes = createSystemProbes(
    {
      dataDir,
      port: 0,
      env: { PATH: bin, ACE_CHROMIUM: join(bin, "codex") },
    },
    systemProbeRuntime,
  );
  const report = await runDoctor(createDoctorChecks(probes), { now: () => 0 });
  expect(report.checks.find((check) => check.id === "provider.codex")?.status).toBe("ok");
  expect(report.checks.find((check) => check.id === "git")?.status).toBe("fail");
  expect(report.checks.find((check) => check.id === "chromium")?.status).toBe("ok");
  expect(report.checks.find((check) => check.id === "disk")?.status).toBe("ok");
});
it("Antigravity discovery reports an installed version and unknown login without entering a session", async () => {
  const root = await temporary();
  await writeFile(
    join(root, "agy"),
    '#!/bin/sh\ncase "$*" in\n"--version") echo "agy 1.2.3";;\n*) exit 99;;\nesac\n',
  );
  await chmod(join(root, "agy"), 0o700);
  const probes = createSystemProbes({ dataDir: root, port: 0, env: { PATH: root } });
  const check = (
    await runDoctor(
      createDoctorChecks(probes).filter((item) => item.id === "provider.antigravity"),
      { now: () => 0 },
    )
  ).checks[0];
  expect(check?.status).toBe("warn");
  expect(check?.message).toContain("1.2.3, unknown");
  expect(check?.message).toContain("interactive verification");
  expect(check?.fix).toContain("agy interactively");
});
it("first-run creation needs write/search permission on the ancestor without requiring directory listing", async () => {
  const root = await temporary();
  await chmod(root, 0o300);
  try {
    const probes = createSystemProbes(
      { dataDir: join(root, "new"), port: 0, env: {} },
      systemProbeRuntime,
    );
    const check = (
      await runDoctor(
        createDoctorChecks(probes).filter((item) => item.id === "disk"),
        { now: () => 0 },
      )
    ).checks[0];
    expect(check?.status).toBe("ok");
    expect(check?.message).toContain("MiB free");
  } finally {
    await chmod(root, 0o700);
  }
});
