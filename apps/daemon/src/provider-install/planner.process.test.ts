import { expect, test } from "vitest";
import { writeFile, symlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { installFixture } from "./testing.ts";

test.each(["npm", "brew", "script", "bun"] as const)(
  "existing %s installs retain their method and exact official package",
  async (method) => {
    const f = await installFixture();
    try {
      const provider = method === "bun" ? "opencode" : "codex";
      await f.existing(provider, method);
      if (method === "script") {
        await symlink("/bin/bash", join(f.bin, "bash"));
        await writeFile(join(f.bin, "curl"), `#!${process.execPath}\nprocess.exit(1)`, {
          mode: 0o755,
        });
      }
      const plan = await f.installs.plan({ provider }, "update");
      expect(plan).toMatchObject({
        method,
        status: "ready",
        installedVersion: "1.0.0",
        needsAdmin: false,
      });
      if (method === "npm")
        expect(plan.commands[0]?.args).toEqual(["install", "-g", "@openai/codex@latest"]);
      if (method === "brew") expect(plan.commands[0]?.args).toEqual(["upgrade", "--cask", "codex"]);
      if (method === "bun")
        expect(plan.commands[0]?.args).toEqual(["install", "-g", "--trust", "@opencode/cli"]);
      if (method === "script")
        expect(plan.commands[0]?.args.at(-1)).toBe(
          `${join(f.bin, "curl")} -fsSL https://chatgpt.com/codex/install.sh | ${join(f.bin, "bash")}`,
        );
    } finally {
      await f.close();
    }
  },
);

test("latest version checks cache registry replies, compare numeric versions, and keep last good facts offline", async () => {
  const f = await installFixture({ managers: ["npm"] });
  try {
    await f.existing("codex");
    await writeFile(join(f.home, "latest"), "1.10.0");
    expect(await f.installs.plan({ provider: "codex" }, "update")).toMatchObject({
      latestVersion: "1.10.0",
      updateAvailable: true,
    });
    await f.installs.plan({ provider: "codex" }, "update");
    expect((await f.calls()).filter((call) => call[1] === "view")).toEqual([
      ["npm", "view", "@openai/codex", "version"],
    ]);
    f.tick(3_600_001);
    await writeFile(join(f.home, "latest"), "offline");
    expect(await f.installs.plan({ provider: "codex" }, "update")).toMatchObject({
      latestVersion: "1.10.0",
      updateAvailable: true,
    });
    f.tick(300_001);
    await writeFile(join(f.home, "latest"), "0.9.0");
    expect(await f.installs.plan({ provider: "codex" }, "update")).toMatchObject({
      latestVersion: "0.9.0",
      updateAvailable: false,
    });
  } finally {
    await f.close();
  }
});

test("Homebrew latest versions use cask metadata while unknown paths and bundled Cursor remain manual", async () => {
  const f = await installFixture();
  try {
    await f.existing("codex", "brew");
    expect(await f.installs.plan({ provider: "codex" }, "update")).toMatchObject({
      latestVersion: "2.0.0",
      updateAvailable: true,
      method: "brew",
    });
    expect(await f.calls()).toContainEqual(["brew", "info", "--json=v2", "--cask", "codex"]);
    await writeFile(join(f.bin, "claude"), `#!${process.execPath}\nconsole.log('1.0.0')`, {
      mode: 0o755,
    });
    expect(await f.installs.plan({ provider: "claude" }, "update")).toMatchObject({
      status: "manual",
      commands: [],
    });
    expect(await f.installs.plan({ provider: "cursor" }, "install")).toMatchObject({
      status: "sign_in",
      commands: [],
    });
    expect(await f.installs.plan({ provider: "antigravity" }, "install")).toMatchObject({
      status: "manual",
      commands: [],
    });
    expect(await f.installs.plan({ provider: "acp", agent: "gemini" }, "install")).toMatchObject({
      commands: [{ args: ["install", "-g", "@google/gemini-cli@latest"] }],
    });
  } finally {
    await f.close();
  }
});

test("official script installation verifies the binary and uninstalls only Claude runtime files", async () => {
  const f = await installFixture({ managers: [] });
  try {
    await symlink("/bin/bash", join(f.bin, "bash"));
    await symlink("/bin/rm", join(f.bin, "rm"));
    const payload = `/bin/mkdir -p "$HOME/.local/bin" "$HOME/.local/share/claude"\n/bin/cat > "$HOME/.local/bin/claude" <<'CLI'\n#!${process.execPath}\nconsole.log('2.0.0');\nCLI\n/bin/chmod +x "$HOME/.local/bin/claude"\n`;
    await writeFile(
      join(f.bin, "curl"),
      `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nappendFileSync(process.env.ACE_INSTALL_CALLS,JSON.stringify(['curl',...process.argv.slice(2)])+'\\n');\nprocess.stdout.write(${JSON.stringify(payload)});`,
      { mode: 0o755 },
    );
    await writeFile(join(f.home, ".claude.json"), "keep credentials and settings");
    await f.request({
      type: "provider.install.run",
      requestId: "script",
      provider: "claude",
      action: "install",
      method: "script",
    });
    expect(await f.wait((event) => ["succeeded", "failed"].includes(event.state))).toMatchObject({
      state: "succeeded",
      version: "2.0.0",
    });
    expect(await f.calls()).toContainEqual(["curl", "-fsSL", "https://claude.ai/install.sh"]);
    const plan = await f.installs.plan({ provider: "claude" }, "uninstall");
    expect(plan.commands.map((command) => command.args)).toEqual([
      ["-f", "--", join(f.home, ".local/bin/claude")],
      ["-rf", "--", join(f.home, ".local/share/claude")],
    ]);
    await f.request({
      type: "provider.install.run",
      requestId: "remove",
      provider: "claude",
      action: "uninstall",
      method: "script",
    });
    expect(
      await f.wait(
        (event) => event.action === "uninstall" && ["succeeded", "failed"].includes(event.state),
      ),
    ).toMatchObject({ state: "succeeded" });
    expect(await readFile(join(f.home, ".claude.json"), "utf8")).toBe(
      "keep credentials and settings",
    );
  } finally {
    await f.close();
  }
});

test("readiness carries cached update facts and clears update availability after installation", async () => {
  const f = await installFixture({ managers: ["npm"] });
  try {
    await f.existing("codex");
    await f.statuses.refreshAfterMutation();
    expect(f.statuses.readiness().find((row) => row.provider === "codex")).toMatchObject({
      version: "1.0.0",
      latestVersion: "2.0.0",
      updateAvailable: true,
    });
    await f.request({
      type: "provider.install.run",
      requestId: "update",
      provider: "codex",
      action: "update",
      method: "npm",
    });
    await f.wait((event) => event.state === "succeeded");
    expect(f.statuses.readiness().find((row) => row.provider === "codex")).toMatchObject({
      version: "2.0.0",
      latestVersion: "2.0.0",
      updateAvailable: false,
    });
  } finally {
    await f.close();
  }
});
