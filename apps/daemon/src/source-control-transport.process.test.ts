import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, delimiter } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { GitService } from "@ace/git";
import { createCommandRunner } from "@ace/forge";
import { SourceControl } from "./source-control.ts";
import { forgeIdentityFixture } from "./forge-identity-test-support.ts";

for (const available of [true, false]) {
  test(`Git transport reports ${available ? "readable" : "failed"} independently of authenticated API access`, async () => {
    const f = await forgeIdentityFixture();
    let source: SourceControl | undefined;
    try {
      const execute = promisify(execFile);
      const target = join(f.root, available ? "remote.git" : "absent.git");
      if (available) await execute("git", ["init", "--bare", "-q", target]);
      const config = join(f.root, "transport.gitconfig");
      await execute("git", [
        "config",
        "--file",
        config,
        `url.${pathToFileURL(target).href}.insteadOf`,
        "git@git.example.com:octo/ace.git",
      ]);
      source = new SourceControl(
        f.settings,
        () =>
          createCommandRunner({
            cwd: f.root,
            env: {
              PATH: `${f.root}${delimiter}${process.env.PATH ?? ""}`,
              ACE_FORGE_FIXTURE: f.root,
              GIT_CONFIG_GLOBAL: config,
              GIT_CONFIG_NOSYSTEM: "1",
            },
          }),
        f.root,
      );
      const status = await source.readiness(f.root, new AbortController().signal, new GitService());
      expect(status.api).toBe("ready");
      expect(status.transport).toBe(available ? "ready" : "failed");
      expect(status.transportInstructions).toMatch(
        available ? /Push permission is verified only/ : /credential helper \/ SSH key/,
      );
    } finally {
      source?.close();
      await f.close();
    }
  });
}
