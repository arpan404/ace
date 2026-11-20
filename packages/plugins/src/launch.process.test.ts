import { readFile, lstat, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { expect, test } from "vitest";
import { launchPluginProcess, withProjectionLock } from "./index.ts";
import { preparePluginSession } from "./session.ts";
import { fixture } from "./test-support.ts";

test.each(["claude", "codex", "cursor", "opencode", "acp", "antigravity"] as const)(
  "%s native process receives plugin overrides and releases the session projection on exit",
  async (provider) => {
    const f = await fixture();
    try {
      await f.manager.accept(await f.prepare());
      const root = join(f.root, "session");
      const marker = join(f.root, "observed.json");
      const script = join(f.root, "standin.cjs");
      await writeFile(
        script,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ args: process.argv.slice(2), config: process.env.OPENCODE_CONFIG_CONTENT, preserved: process.env.PRESERVED }));`,
      );
      const process = await launchPluginProcess(f.manager, provider, root, {
        command: globalThis.process.execPath,
        args: [script, "base-argument"],
        env: { PRESERVED: "yes" },
        name: "standin",
      });
      await process.exited;
      const observed = z
        .object({ args: z.array(z.string()), config: z.string().optional(), preserved: z.string() })
        .parse(JSON.parse(await readFile(marker, "utf8")));
      expect(observed.preserved).toBe("yes");
      expect(observed.args[0]).toBe("base-argument");
      if (provider === "claude" || provider === "cursor")
        expect(observed.args).toContain("--plugin-dir");
      else if (provider === "codex")
        expect(observed.args).toContain("plugins.sample@ace.enabled=true");
      else if (provider === "opencode")
        expect(JSON.parse(observed.config ?? "null")).toMatchObject({
          mcp: { "ace-sample__tools": { type: "local" } },
        });
      else
        expect(process.sessionConfig.mcpServers).toContainEqual(
          expect.objectContaining({ name: "ace-sample__tools", command: "node" }),
        );
      // The launch's own directory, projection and all, is gone with it.
      expect(await readdir(root)).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

test("OpenCode launch preserves existing runtime MCP servers and instruction paths", async () => {
  const f = await fixture();
  try {
    await f.manager.accept(await f.prepare());
    const marker = join(f.root, "config.json");
    const script = join(f.root, "standin.cjs");
    await writeFile(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.env.OPENCODE_CONFIG_CONTENT);`,
    );
    const launched = await launchPluginProcess(f.manager, "opencode", join(f.root, "session"), {
      command: process.execPath,
      args: [script],
      name: "standin",
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          theme: "dark",
          mcp: { ace: { type: "remote", url: "http://127.0.0.1:1234/mcp" } },
          instructions: ["/owned/base.md"],
          skills: { paths: ["/owned/base-skills"] },
        }),
      },
    });
    await launched.exited;
    const config = z
      .object({
        theme: z.string(),
        mcp: z.record(z.string(), z.unknown()),
        instructions: z.array(z.string()),
        skills: z.object({ paths: z.array(z.string()) }),
      })
      .parse(JSON.parse(await readFile(marker, "utf8")));
    expect(config.theme).toBe("dark");
    expect(config.mcp).toMatchObject({
      ace: { url: "http://127.0.0.1:1234/mcp" },
      "ace-sample__tools": { type: "local" },
    });
    expect(config.instructions).toContain("/owned/base.md");
    expect(config.skills.paths).toContain("/owned/base-skills");
  } finally {
    await f.close();
  }
});

test("a relaunch while the last launch's cleanup stalls keeps its own files when that cleanup ends", async () => {
  const f = await fixture();
  // A filesystem that hangs under the first launch's removal, holding that launch's lock.
  const stalled = Promise.withResolvers<void>();
  try {
    await f.manager.accept(await f.prepare());
    const root = join(f.root, "session");
    let launches = 0;
    const prepare: typeof preparePluginSession = async (manager, provider, directory) => {
      const session = await preparePluginSession(manager, provider, directory);
      if (launches++ > 0) return session;
      return {
        ...session,
        close: () => withProjectionLock(directory, () => stalled.promise).then(session.close),
      };
    };
    const ids = ["first", "second"];
    const launch = (args: string[]) =>
      launchPluginProcess(
        f.manager,
        "claude",
        root,
        { command: process.execPath, args, env: {}, name: "standin" },
        undefined,
        { prepare, releaseMs: 50, id: () => ids.shift() ?? "extra" },
      );
    const first = await launch(["-e", ""]);
    const settled = await Promise.race([
      first.exited.then(() => "exited"),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 5_000)),
    ]);
    // Reported past the cap while its removal still waits.
    expect(settled).toBe("exited");
    const second = await launch(["-e", "setInterval(() => {}, 1000)"]);
    try {
      const own = join(root, "launch-second", "generated");
      await expect(lstat(own)).resolves.toBeDefined();
      stalled.resolve();
      await expect.poll(() => readdir(root)).toEqual(["launch-second"]);
      await expect(lstat(own)).resolves.toBeDefined();
    } finally {
      await second.stop({ graceMs: 0 });
    }
    expect(await readdir(root)).toEqual([]);
  } finally {
    stalled.resolve();
    await f.close();
  }
});
