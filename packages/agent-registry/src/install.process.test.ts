import { expect, test } from "vitest";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registry, temporary, body, sample, executable } from "./testing/support.ts";
import type { RegistryResult } from "@ace/protocol";
const request: typeof fetch = async () => new Response(body([sample()]));
function plan(reply: RegistryResult): string {
  if (!reply.result.ok || !("plan" in reply.result)) throw new Error("No install plan");
  return reply.result.plan.digest;
}
test("listing and planning never install, and checksum mismatch never publishes executable code", async () => {
  const work = await temporary();
  let downloads = 0;
  const service = await registry(
    work.root,
    async () => new Response(body([sample()])),
    async () => {
      downloads++;
      return new Response("wrong artifact");
    },
  );
  try {
    await service.catalog.refresh();
    await service.handle({ type: "registry.list", requestId: "list", offset: 0, limit: 10 });
    const digest = plan(
      await service.handle({
        type: "registry.install-plan",
        requestId: "preview",
        acpAgentId: "official:sample",
        runtime: "binary",
      }),
    );
    expect(downloads).toBe(0);
    const result = await service.handle({
      type: "registry.install-intent",
      requestId: "install",
      intentId: "approved",
      digest,
    });
    expect(result.result.ok).toBe(false);
    expect(downloads).toBe(1);
    expect(service.inventory.list()).toEqual([]);
    expect(await readdir(join(work.root, "installations"))).toEqual([]);
  } finally {
    await service.close();
    await work.close();
  }
});
test("changed distribution requires new consent and cannot reuse an old intent digest", async () => {
  const work = await temporary();
  let version = "1.0.0";
  let downloads = 0;
  const service = await registry(
    work.root,
    async () => new Response(body([sample(version)])),
    async () => {
      downloads++;
      return new Response("synthetic artifact");
    },
  );
  try {
    await service.catalog.refresh();
    const old = plan(
      await service.handle({
        type: "registry.install-plan",
        requestId: "plan",
        acpAgentId: "official:sample",
        runtime: "binary",
      }),
    );
    version = "1.0.1";
    await service.catalog.refresh();
    expect(
      (
        await service.handle({
          type: "registry.install-intent",
          requestId: "install",
          digest: old,
          intentId: "old-consent",
        })
      ).result,
    ).toMatchObject({ ok: false, reason: expect.stringContaining("changed") });
    expect(downloads).toBe(0);
  } finally {
    await service.close();
    await work.close();
  }
});
test("cancelled downloads remove staging and preserve an approved prior local installation", async () => {
  const work = await temporary();
  const started = Promise.withResolvers<void>();
  const service = await registry(
    work.root,
    async () => new Response(body([sample()])),
    async (_url, options) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from("unfinished"));
            options?.signal?.addEventListener(
              "abort",
              () => controller.error(new Error("aborted")),
              { once: true },
            );
            started.resolve();
          },
        }),
      ),
  );
  try {
    await service.bind({
      acpAgentId: "local:old",
      installationId: "old",
      instanceId: "home-old",
      version: "1.0.0",
      command: await executable(work.root, "old-cli"),
      args: [],
    });
    await service.catalog.refresh();
    const digest = plan(
      await service.handle({
        type: "registry.install-plan",
        requestId: "plan",
        acpAgentId: "official:sample",
        runtime: "binary",
      }),
    );
    const pending = service.handle({
      type: "registry.install-intent",
      requestId: "install",
      intentId: "cancel-me",
      digest,
    });
    await started.promise;
    expect(
      (await service.handle({ type: "registry.list", requestId: "progress", offset: 0, limit: 1 }))
        .result,
    ).toMatchObject({ activeInstall: { intentId: "cancel-me", digest, phase: "download" } });
    expect(
      (
        await service.handle({
          type: "registry.install-cancel",
          requestId: "cancel",
          intentId: "cancel-me",
        })
      ).result,
    ).toEqual({ ok: true, cancelled: true });
    expect((await pending).result).toMatchObject({ ok: false, reason: "Installation cancelled" });
    expect(service.inventory.list().map((value) => value.installationId)).toEqual(["old"]);
    expect(
      (await service.handle({ type: "registry.list", requestId: "done", offset: 0, limit: 1 }))
        .result,
    ).not.toHaveProperty("activeInstall");
    expect(
      (
        await service.handle({
          type: "registry.install-cancel",
          requestId: "repeat-cancel",
          intentId: "cancel-me",
        })
      ).result,
    ).toEqual({ ok: true, cancelled: false });
    expect(await readdir(join(work.root, "installations"))).toEqual([]);
    expect(
      (
        await service.resolve({
          acpAgentId: "local:old",
          installationId: "old",
          instanceId: "home-old",
        })
      ).command,
    ).toContain("old-cli");
  } finally {
    await service.close();
    await work.close();
  }
});
test("approved installs persist across restart and artifact replacement needs new approval", async () => {
  const work = await temporary();
  let service = await registry(work.root, request, async () => new Response("synthetic artifact"));
  try {
    await service.catalog.refresh();
    const digest = plan(
      await service.handle({
        type: "registry.install-plan",
        requestId: "plan",
        acpAgentId: "official:sample",
        runtime: "binary",
      }),
    );
    const installed = await service.handle({
      type: "registry.install-intent",
      requestId: "install",
      intentId: "intent",
      digest,
    });
    if (!installed.result.ok || !("installation" in installed.result))
      throw new Error("Missing installation");
    const identity = installed.result.installation;
    const launch = await service.resolve(identity);
    expect(await readFile(launch.command, "utf8")).toBe("synthetic artifact");
    await service.close();
    service = await registry(work.root, request);
    expect((await service.resolve(identity)).command).toBe(launch.command);
    await writeFile(launch.command, "changed executable");
    await expect(service.resolve(identity)).rejects.toThrow("changed");
    const invalid = { ...identity, acpAgentId: "local:impostor" };
    await expect(service.resolve(invalid)).rejects.toThrow("unavailable");
  } finally {
    await service.close();
    await work.close();
  }
});
test("Claude and Codex bridges use the selected user binary and selected home rather than bundled defaults", async () => {
  const work = await temporary();
  const service = await registry(work.root, async () => new Response(body([])));
  try {
    const bridge = await executable(work.root, "bridge");
    for (const [agent, version, variable, home] of [
      ["claude-acp", "0.85.1", "CLAUDE_CODE_EXECUTABLE", "CLAUDE_CONFIG_DIR"],
      ["codex-acp", "2.1.1", "CODEX_PATH", "CODEX_HOME"],
    ] as const) {
      const native = await executable(work.root, agent);
      const identity = {
        acpAgentId: `official:${agent}`,
        installationId: agent,
        instanceId: `instance-${agent}`,
      };
      await service.bind({
        ...identity,
        version,
        command: bridge,
        underlyingCommand: native,
        args: [],
      });
      const launch = await service.resolve(identity, {
        [home]: `/private/${agent}`,
        [variable]: "/bundled/wrong",
      });
      expect(launch.env[variable]).toBe(native);
      expect(launch.env[home]).toBe(`/private/${agent}`);
      await writeFile(native, "new version");
      await expect(service.resolve(identity)).rejects.toThrow("changed");
    }
    await expect(
      service.bind({
        acpAgentId: "official:claude-acp",
        installationId: "missing",
        instanceId: "missing",
        command: bridge,
        args: [],
        version: "0.85.1",
        underlyingCommand: join(work.root, "missing-cli"),
      }),
    ).rejects.toThrow("user's installed");
  } finally {
    await service.close();
    await work.close();
  }
});

test("approved npm installation retains exact package identity and the manager's lock integrity", async () => {
  const work = await temporary();
  const manager = await executable(
    work.root,
    "selected-manager",
    `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const root = process.argv[process.argv.indexOf("--prefix") + 1];
const pkg = join(root, "node_modules", "sample");
mkdirSync(pkg, { recursive: true });
writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "sample", version: "1.0.0", bin: "entry.js" }));
writeFileSync(join(pkg, "entry.js"), "#!/usr/bin/env node\\n");
writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/sample": { version: "1.0.0", integrity: "sha512-c3ludGhldGlj" } } }));
`,
  );
  const agent = {
    ...sample(),
    distribution: { npx: { package: "sample@1.0.0", args: [], env: {} } },
  };
  const service = await registry(work.root, async () => new Response(body([agent])), undefined, {
    npm: manager,
  });
  try {
    await service.catalog.refresh();
    const preview = await service.handle({
      type: "registry.install-plan",
      requestId: "plan",
      acpAgentId: "official:sample",
      runtime: "npm",
    });
    if (!preview.result.ok || !("plan" in preview.result)) throw new Error("No npm plan");
    expect(preview.result.plan.argv).toContain("sample@1.0.0");
    const reply = await service.handle({
      type: "registry.install-intent",
      requestId: "install",
      intentId: "npm-approved",
      digest: preview.result.plan.digest,
    });
    if (!reply.result.ok || !("installation" in reply.result))
      throw new Error("No npm installation");
    expect(reply.result.installation.packageManager).toEqual({
      command: manager,
      package: "sample@1.0.0",
      integrity: "sha512-c3ludGhldGlj",
    });
    const launch = await service.resolve(reply.result.installation);
    expect(launch.command).toContain("node_modules/sample/entry.js");
  } finally {
    await service.close();
    await work.close();
  }
});
