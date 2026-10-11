import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { spawnGitProcess } from "@ace/git";
import { setup } from "./publication-project-test-support.ts";

function gate() { let open = () => {}; const promise = new Promise<void>((resolve) => { open = resolve; }); return { promise, open: () => open() }; }
for (const phase of ["adding origin", "pushing"] as const) {
  test(`preferences changed during Git metadata before ${phase} prevent the effect`, async () => {
    const held = gate(); let probes = 0; let pid: number | undefined;
    const f = await setup({}, { git: { processRuntime: { spawn(command, args, options) {
      const child = spawnGitProcess(command, args, options);
      if (args.includes("rev-parse") && args.includes("--verify") && args.includes("HEAD") &&
        ++probes === (phase === "adding origin" ? 2 : 3)) {
        pid = child.pid;
        if (pid === undefined) throw new Error("Missing Git process");
        // Stop a real process at the metadata edge; provider data and Git effects stay real.
        process.kill(-pid, "SIGSTOP"); held.open();
      }
      return child;
    } } } });
    try {
      const remote = join(f.root, "remote.git");
      await mkdir(remote); await f.git(remote, ["init", "--bare"]);
      await appendFile(join(f.root, "gitconfig"), `\n[url "file://${remote}"]\n\tinsteadOf = https://github.com/octo/engine.git\n`);
      await writeFile(join(f.path, "readme"), "safe");
      await f.git(f.path, ["add", "readme"]);
      await f.git(f.path, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Initial"]);
      const pending = f.publish();
      await held.promise;
      await f.cli.settings.set("sourceControl.preferences", { hosts: [{ host: "github.com", account: "other" }], host: "github.com", remote: "origin" }, { kind: "global" });
      expect(await pending).toMatchObject({ ok: false, error: "forge_preferences_changed", publication: { remote: { id: 1 } } });
      await expect(f.git(remote, ["rev-parse", "--verify", "HEAD"])).rejects.toThrow();
      expect((await f.git(f.path, ["remote"])).stdout.trim()).toBe(phase === "adding origin" ? "" : "origin");
    } finally {
      if (pid !== undefined) { try { process.kill(-pid, "SIGCONT"); } catch { /* The preference change terminated it. */ } }
      await f.cleanup();
    }
  });
}
