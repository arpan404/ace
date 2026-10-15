import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, delimiter } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { GitService } from "@ace/git";
import { createCommandRunner } from "@ace/forge";
import { SourceControl } from "./source-control.ts";
import { forgeIdentityFixture } from "./forge-identity-test-support.ts";

for (const [available, protocols, ready] of [
  [true, ["file"], true],
  [false, ["file"], false],
  // Plain `git ls-remote` reads this remote, but a push could not: readiness says so.
  [true, undefined, false],
] as const) {
  test(`Git transport reports ${ready ? "readable" : "failed"} for ${available ? "a reachable" : "an absent"} remote ${protocols ? "over its admitted protocol" : "a push may not use"}, independently of API access`, async () => {
    const f = await forgeIdentityFixture();
    let source: SourceControl | undefined;
    const git = new GitService({
      credentialHelperLookup: async () => [],
      ...(protocols ? { transportProtocols: protocols } : {}),
    });
    try {
      const execute = promisify(execFile);
      const target = join(f.root, available ? "remote.git" : "absent.git");
      if (available) await execute("git", ["init", "--bare", "-q", target]);
      await execute("git", [
        "-C",
        f.root,
        "config",
        `url.${pathToFileURL(target).href}.insteadOf`,
        "git@git.example.com:octo/ace.git",
      ]);
      if (available)
        await execute("git", ["-C", f.root, "ls-remote", "--", "upstream"], { timeout: 30_000 });
      source = new SourceControl(
        f.settings,
        () =>
          createCommandRunner({
            cwd: f.root,
            env: {
              PATH: `${f.root}${delimiter}${process.env.PATH ?? ""}`,
              ACE_FORGE_FIXTURE: f.root,
            },
          }),
        f.root,
      );
      const status = await source.readiness(f.root, new AbortController().signal, git);
      expect(status.api).toBe("ready");
      expect(status.transport).toBe(ready ? "ready" : "failed");
      expect(status.transportInstructions).toMatch(
        ready ? /Push permission is verified only/ : /credential helper \/ SSH key/,
      );
    } finally {
      source?.close();
      await git.close();
      await f.close();
    }
  });
}
