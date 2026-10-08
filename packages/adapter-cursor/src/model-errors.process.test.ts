import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { CursorHost } from "@ace/adapter-cursor/discovery";

test.each(["not_configured", "auth_expired", "unreachable"])(
  "the Cursor SDK host preserves %s through its real JSON-RPC pipe without exposing vendor text",
  async (code) => {
    const home = await mkdtemp(join(tmpdir(), "ace-cursor-model-error-"));
    const entry = join(home, "fake-host.mjs");
    const hostWireUrl = new URL("./host-wire.ts", import.meta.url).href;
    await writeFile(
      entry,
      `import { hostWire } from ${JSON.stringify(hostWireUrl)};
hostWire(async () => { throw { code: ${JSON.stringify(code)}, message: 'Bearer private-vendor-token', password: 'private-password' }; }, () => process.exit(0));\n`,
    );
    const host = new CursorHost({ entry, env: { HOME: home }, limits: { graceMs: 0 } }, () => {});
    try {
      await expect(host.request("models")).rejects.toMatchObject({ code });
      expect(host.failureMessage ?? "").not.toContain("private");
      await host.process.exited;
    } finally {
      await host.stop();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test.each(["missing", "incomplete", "wrong-version"] as const)(
  "Cursor SDK installation preconditions identify %s setup before starting a host",
  async (setup) => {
    const { createCursorAccountDriver } = await import("./index.ts");
    const home = await mkdtemp(join(tmpdir(), "ace-cursor-model-precondition-"));
    const driver = createCursorAccountDriver({
      launchEnv: {},
      stopInstance: async () => {},
      spawn: () => {
        throw new Error("Unavailable SDK must not start a host");
      },
      discovery: {
        platform: "darwin",
        arch: "arm64",
        nodeVersion: "24.0.0",
        resolve: (id) => {
          if (setup === "missing")
            throw Object.assign(new Error("private module path"), { code: "MODULE_NOT_FOUND" });
          return id === "@cursor/sdk" ? "/sdk/dist/esm/index.js" : "/helper/package.json";
        },
        read: async (path) => {
          if (setup === "incomplete" && path === "/helper/package.json")
            throw new Error("private missing helper");
          return JSON.stringify({
            name: path === "/sdk/package.json" ? "@cursor/sdk" : "@cursor/sdk-darwin-arm64",
            version: setup === "wrong-version" ? "0.9.0" : "1.0.35",
          });
        },
        executable: async () => {},
      },
    });
    const diagnostics: { cliVersion?: string }[] = [];
    try {
      await expect(
        driver.models(
          { id: "synthetic", homeDir: home },
          new AbortController().signal,
          (metadata) => diagnostics.push(metadata),
        ),
      ).rejects.toMatchObject({
        code: setup === "wrong-version" ? "cli_too_old" : "not_configured",
        message: "Cursor SDK backend is unavailable",
      });
      expect(diagnostics).toEqual([
        setup === "missing" ? {} : { cliVersion: setup === "wrong-version" ? "0.9.0" : "1.0.35" },
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("Cursor host startup errors without an RPC reply identify missing local setup", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-cursor-host-startup-"));
  const entry = join(home, "failed-host.mjs");
  await writeFile(
    entry,
    "console.error('Error: Cannot find module fake-sdk-host'); process.exit(1);\n",
  );
  const host = new CursorHost({ entry, env: { HOME: home }, limits: { graceMs: 0 } }, () => {});
  try {
    await expect(host.request("models")).rejects.toMatchObject({ code: "not_configured" });
    await host.process.exited;
  } finally {
    await host.stop();
    await rm(home, { recursive: true, force: true });
  }
});
