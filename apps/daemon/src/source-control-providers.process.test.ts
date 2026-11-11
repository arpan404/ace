import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SettingsService } from "@ace/settings";
import { createCommandRunner } from "@ace/forge";
import { SourceControl } from "./source-control.ts";

test("GitLab readiness uses glab for the configured host instead of gh", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-gitlab-cli-"));
  const settings = new SettingsService({ dataDir: root });
  let source: SourceControl | undefined;
  try {
    await writeFile(
      join(root, "glab"),
      `#!${process.execPath}
const args=process.argv.slice(2);
if(args[0]==='--version') console.log('glab version 1.55.0');
else if(args[0]==='api' && args[1]==='user' && args.includes('--include') && args[args.indexOf('--hostname')+1]==='git.example.com') console.log('HTTP/2.0 200 OK\\n\\n'+JSON.stringify({username:'a.user_1'}));
else process.exit(2);
`,
      { mode: 0o755 },
    );
    await settings.set(
      "sourceControl.preferences",
      {
        hosts: [
          { host: "github.com" },
          { host: "git.example.com", forge: "gitlab", account: "a.user_1" },
        ],
        host: "git.example.com",
        remote: "origin",
      },
      { kind: "global" },
    );
    source = new SourceControl(
      settings,
      () => createCommandRunner({ cwd: root, env: { PATH: root } }),
      root,
    );
    const result = await source.readiness(root, new AbortController().signal);
    expect(result).toMatchObject({ cli: "available", account: "a.user_1", api: "ready" });
  } finally {
    source?.close();
    await settings.close();
    await rm(root, { recursive: true, force: true });
  }
});
