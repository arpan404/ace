import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SettingsService } from "@ace/settings";
import { SourceControlPreferences } from "@ace/protocol";
import { createCommandRunner } from "@ace/forge";
import { SourceControl } from "./source-control.ts";
import { workspaceRepository } from "./workspace-repository.ts";

test("saved provider mappings survive restart, resolve checkout identity and refuse GitHub API dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-forge-hosts-"));
  let settings = new SettingsService({ dataDir: root });
  let source: SourceControl | undefined;
  try {
    const preferences = SourceControlPreferences.parse({
      hosts: [
        { host: "github.com" },
        { host: "git.example.com", forge: "gitbucket", account: "a.user" },
      ],
      host: "git.example.com",
      remote: "origin",
    });
    await settings.set("sourceControl.preferences", preferences, { kind: "global" });
    await settings.close();
    settings = new SettingsService({ dataDir: root });
    source = new SourceControl(
      settings,
      () => async () => {
        throw new Error("Wrong provider reached the GitHub CLI");
      },
      root,
    );
    const saved = await source.preferences();
    expect(
      workspaceRepository(
        [{ name: "origin", fetchUrls: ["git@git.example.com:team/repo.git"] }],
        saved,
      ),
    ).toEqual({ forge: "gitbucket", host: "git.example.com", owner: "team", name: "repo" });
    const status = await source.readiness(root, new AbortController().signal);
    expect(status.api).toBe("unavailable");
    expect(status.instructions).toContain("not available yet");
    await expect(
      source.identity(root, "git.example.com", new AbortController().signal),
    ).rejects.toMatchObject({ kind: "unsupported" });
    expect(
      workspaceRepository([{ name: "origin", fetchUrls: ["git@github.com:team/repo.git"] }], saved)
        ?.forge,
    ).toBe("github");
  } finally {
    source?.close();
    await settings.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
