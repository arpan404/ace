import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SettingsService } from "@ace/settings";
import { SourceControlPreferences } from "@ace/protocol";
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

test("a host saved without a provider on gitlab.com still loads, saves and routes as GitLab", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-forge-legacy-"));
  // Settings written before providers existed: any host, no `forge`.
  await writeFile(
    join(root, "settings.json"),
    JSON.stringify({
      "sourceControl.preferences": {
        hosts: [{ host: "github.com" }, { host: "gitlab.com" }],
        host: "gitlab.com",
        remote: "origin",
      },
    }),
  );
  const settings = new SettingsService({ dataDir: root });
  const source = new SourceControl(
    settings,
    () => async () => {
      throw new Error("Routing needs no CLI");
    },
    root,
  );
  try {
    const saved = await source.preferences();
    expect(
      workspaceRepository(
        [{ name: "origin", fetchUrls: ["git@gitlab.com:group/sub/repo.git"] }],
        saved,
      ),
    ).toEqual({ forge: "gitlab", host: "gitlab.com", owner: "group/sub", name: "repo" });
    // The loaded document doesn't block later saves.
    await settings.set(
      "sourceControl.preferences",
      { ...saved, remote: "upstream" },
      { kind: "global" },
    );
    expect((await source.preferences()).remote).toBe("upstream");
  } finally {
    source.close();
    await settings.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit provider that contradicts a public host is refused with its own reason", () => {
  const result = SourceControlPreferences.safeParse({
    hosts: [{ host: "gitlab.com", forge: "github" }],
    host: "gitlab.com",
    remote: "origin",
  });
  expect(result.success).toBe(false);
  expect(result.error?.issues.map((issue) => issue.message).join("\n")).toContain(
    "provider must match the host",
  );
});
