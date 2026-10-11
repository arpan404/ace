import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command, WorkspaceId } from "@ace/protocol";
import { Projects } from "./projects.ts";
import { projectFixture } from "./projects-test-support.ts";
import { publicationCli } from "./publication-test-support.ts";

const input = {
  host: "github.com",
  account: "octo",
  owner: "octo",
  name: "engine",
  description: "A project",
  visibility: "private",
} as const;
async function setup(options: Parameters<typeof publicationCli>[0] = {}) {
  const cli = await publicationCli(options);
  const f = await projectFixture({
    sourceControl: cli.source,
    gitPolicy: { protocols: ["https", "ssh", "file"] },
  });
  const path = join(f.root, "project");
  await mkdir(path);
  await f.git(path, ["init"]);
  const added = await f.command({ type: "workspace.add", path });
  const id = WorkspaceId.parse(added.workspace?.id);
  return {
    ...f,
    cli,
    path,
    id,
    async cleanup() {
      await f.close();
      await cli.close();
    },
    publish: () => f.command({ type: "workspace.publish", workspaceId: id, input }),
  };
}
test("an empty local repository creates one remote and explains that its first push needs a commit", async () => {
  const f = await setup();
  try {
    const result = await f.publish();
    expect(result).toMatchObject({
      ok: true,
      publication: { phase: "empty", remote: { id: 1, visibility: "private" } },
      inspection: {
        git: { remotes: [{ name: "origin", fetchUrls: ["https://github.com/octo/engine.git"] }] },
      },
    });
    expect((await f.git(f.path, ["remote", "get-url", "origin"])).stdout.trim()).toBe(
      "https://github.com/octo/engine.git",
    );
    expect((await f.publish()).publication?.remote?.id).toBe(1);
    expect((await f.cli.state()).creates).toBe(1);
  } finally {
    await f.cleanup();
  }
});
test("a lost creation response is reconciled and survives a daemon restart without creating again", async () => {
  const f = await setup({ loseReply: true });
  let restarted: Projects | undefined;
  try {
    expect(await f.publish()).toMatchObject({
      ok: true,
      publication: { phase: "empty", remote: { id: 1 } },
    });
    await f.projects.close();
    restarted = new Projects(f.store, () => 2000, {
      home: f.root,
      roots: async () => [f.root],
      sourceControl: f.cli.source,
    });
    expect(await restarted.publicationStatus(f.id, () => true)).toMatchObject({
      phase: "empty",
      remote: { id: 1 },
    });
    expect(
      await restarted.execute(
        Command.parse({
          id: "resume-after-restart",
          deviceId: "owner",
          payload: { type: "workspace.publish", workspaceId: f.id, input },
        }),
      ),
    ).toMatchObject({ ok: true, publication: { remote: { id: 1 } } });
    expect((await f.cli.state()).creates).toBe(1);
  } finally {
    await restarted?.close();
    await f.cleanup();
  }
});
test("a preexisting origin prevents hosted creation and is never replaced", async () => {
  const f = await setup();
  try {
    await f.git(f.path, ["remote", "add", "origin", "https://github.com/someone/existing.git"]);
    expect(await f.publish()).toMatchObject({ ok: false, error: "publication_origin_exists" });
    expect((await f.cli.state()).creates).toBe(0);
    expect((await f.git(f.path, ["remote", "get-url", "origin"])).stdout.trim()).toBe(
      "https://github.com/someone/existing.git",
    );
  } finally {
    await f.cleanup();
  }
});
test("the first commit pushes to the durable created repository and refreshes project metadata", async () => {
  const f = await setup();
  try {
    const remote = join(f.root, "remote.git");
    await mkdir(remote);
    await f.git(remote, ["init", "--bare"]);
    await appendFile(
      join(f.root, "gitconfig"),
      `\n[url "file://${remote}"]\n\tinsteadOf = https://github.com/octo/engine.git\n`,
    );
    await writeFile(join(f.path, "readme"), "hello");
    await f.git(f.path, ["add", "readme"]);
    await f.git(f.path, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "initial",
    ]);
    const changes: string[] = [];
    const stop = f.projects.subscribe((event) => changes.push(event.change));
    expect(await f.publish()).toMatchObject({
      ok: true,
      publication: { phase: "pushed", remote: { id: 1 } },
    });
    stop();
    expect((await f.git(remote, ["rev-parse", "refs/heads/trunk"])).stdout.trim()).toBe(
      (await f.git(f.path, ["rev-parse", "HEAD"])).stdout.trim(),
    );
    expect(changes).toContain("updated");
  } finally {
    await f.cleanup();
  }
});
test("Git push failure retains created identity and a retry pushes without another API write", async () => {
  const f = await setup();
  try {
    const remote = join(f.root, "missing.git");
    await appendFile(
      join(f.root, "gitconfig"),
      `\n[url "file://${remote}"]\n\tinsteadOf = https://github.com/octo/engine.git\n`,
    );
    await writeFile(join(f.path, "readme"), "hello");
    await f.git(f.path, ["add", "readme"]);
    await f.git(f.path, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "initial",
    ]);
    expect(await f.publish()).toMatchObject({
      ok: false,
      error: "publication_git_transport_failed",
      publication: { phase: "origin_added", remote: { id: 1 } },
    });
    await mkdir(remote);
    await f.git(remote, ["init", "--bare"]);
    expect(await f.publish()).toMatchObject({
      ok: true,
      publication: { phase: "pushed", remote: { id: 1 } },
    });
    expect((await f.cli.state()).creates).toBe(1);
  } finally {
    await f.cleanup();
  }
});
test("revoking publication authority cancels its CLI and resume reconciles the created repository", async () => {
  const f = await setup({ hold: true });
  try {
    const pending = f.publish();
    await Promise.race([
      f.cli.created(),
      pending.then(() => {
        throw new Error("Publication ended before its creation effect was observed");
      }),
    ]);
    expect((await f.cli.state()).creates).toBe(1);
    expect(await f.publish()).toMatchObject({ ok: false, error: "project_busy" });
    expect(
      await f.command({ type: "workspace.remove", workspaceId: f.id, archiveThreads: false }),
    ).toMatchObject({ ok: false, error: "project_busy" });
    f.projects.cancelDevice("owner");
    expect(await pending).toMatchObject({
      ok: false,
      error: "publication_cancelled",
      publication: { phase: "creating" },
    });
    await f.cli.update({ hold: false });
    expect(await f.publish()).toMatchObject({
      ok: true,
      publication: { phase: "empty", remote: { id: 1 } },
    });
    expect((await f.cli.state()).creates).toBe(1);
  } finally {
    await f.cleanup();
  }
});

test("a changed API account fails before creating a repository", async () => {
  const f = await setup();
  try {
    await f.cli.update({ account: "other" });
    expect(await f.publish()).toMatchObject({ ok: false, error: "publication_account_changed" });
    expect((await f.cli.state()).creates).toBe(0);
    expect((await f.git(f.path, ["remote"])).stdout.trim()).toBe("");
  } finally {
    await f.cleanup();
  }
});

test("an origin edited after publication is preserved while resume refuses to push", async () => {
  const f = await setup();
  try {
    expect(await f.publish()).toMatchObject({ ok: true, publication: { remote: { id: 1 } } });
    await f.git(f.path, ["remote", "set-url", "origin", "https://github.com/other/repo.git"]);
    expect(await f.publish()).toMatchObject({
      ok: false,
      error: "publication_origin_exists",
      publication: { remote: { id: 1 } },
    });
    expect((await f.git(f.path, ["remote", "get-url", "origin"])).stdout.trim()).toBe(
      "https://github.com/other/repo.git",
    );
    expect((await f.cli.state()).creates).toBe(1);
  } finally {
    await f.cleanup();
  }
});

test("preferences changed during creation retain the remote receipt and stop local publication until reconciliation", async () => {
  const f = await setup({ hold: true });
  try {
    const pending = f.publish();
    await f.cli.created();
    await f.cli.settings.set(
      "sourceControl.preferences",
      {
        hosts: [{ host: "github.com", account: "other" }],
        host: "github.com",
        remote: "origin",
      },
      { kind: "global" },
    );
    await f.cli.update({ hold: false });
    expect(await pending).toMatchObject({
      ok: false,
      error: "forge_outcome_uncertain",
      publication: {
        phase: "remote_created",
        remote: { id: 1 },
      },
    });
    expect((await f.git(f.path, ["remote"])).stdout.trim()).toBe("");
    await f.cli.settings.set(
      "sourceControl.preferences",
      {
        hosts: [{ host: "github.com", account: "octo" }],
        host: "github.com",
        remote: "origin",
      },
      { kind: "global" },
    );
    expect(await f.publish()).toMatchObject({
      ok: true,
      publication: { phase: "empty", remote: { id: 1 } },
    });
    expect((await f.cli.state()).creates).toBe(1);
  } finally {
    await f.cleanup();
  }
});

test("a creation preflight failure releases its reservation and a new command can publish", async () => {
  const f = await setup();
  try {
    // Initial admission and exact-name GET precede the create's identity probe.
    await f.cli.update({ invalidUser: 4 });
    expect(await f.publish()).toMatchObject({
      ok: false,
      error: "forge_invalid_data",
      publication: { phase: "prepared", remote: null },
    });
    expect((await f.cli.state()).creates).toBe(0);
    expect((await f.git(f.path, ["remote"])).stdout.trim()).toBe("");
    expect(await f.publish()).toMatchObject({
      ok: true,
      publication: { phase: "empty", remote: { id: 1 } },
    });
    expect((await f.cli.state()).creates).toBe(1);
  } finally {
    await f.cleanup();
  }
});

test("case-equivalent publication intents resume the saved repository without another creation", async () => {
  const f = await setup();
  try {
    expect(
      await f.command({
        type: "workspace.publish",
        workspaceId: f.id,
        input: { ...input, owner: "Octo", name: "Engine" },
      }),
    ).toMatchObject({ ok: true, publication: { phase: "empty", remote: { id: 1 } } });
    expect(await f.publish()).toMatchObject({
      ok: true,
      publication: { phase: "empty", remote: { id: 1 } },
    });
    expect((await f.cli.state()).creates).toBe(1);
  } finally {
    await f.cleanup();
  }
});
