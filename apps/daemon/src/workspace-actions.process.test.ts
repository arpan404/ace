import { mkdtemp, rm, writeFile, chmod, symlink, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { Thread, Command } from "@ace/protocol";

test("workspace reads expose declared scripts and installed editors and receipts return a native editor descriptor", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-workspace-actions-"));
  const store = new Store(join(root, "events.sqlite"));
  const workspaceId = store.createWorkspace(root, "Project");
  const thread = Thread.parse({
    id: "thread",
    workspaceId,
    provider: "codex",
    title: "Project thread",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  const runtime = new WorkspaceRuntime(store, root, () => 1000, {
    editorPath: root,
    platform: "linux",
  });
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { dev: "echo dev", build: "echo build" } }),
    );
    await writeFile(join(root, "Procfile"), "web: echo web\n");
    await writeFile(join(root, "Makefile"), "test:\n\techo test\n");
    await writeFile(join(root, "justfile"), "serve:\n  echo serve\n");
    const scripts = await runtime.read({
      type: "workspace.request",
      requestId: "scripts",
      operation: { op: "scripts.list", threadId: thread.id },
    });
    expect(scripts.result).toMatchObject({
      kind: "scripts",
      scripts: expect.arrayContaining([
        { id: "package.json:dev", name: "dev", source: "package.json", command: "npm run 'dev'" },
        { id: "Procfile:web", name: "web", source: "Procfile", command: "echo web" },
      ]),
    });
    await writeFile(join(root, "code"), "#!/bin/sh\nexit 0\n");
    await chmod(join(root, "code"), 0o700);
    expect(
      (
        await runtime.read({
          type: "workspace.request",
          requestId: "editors",
          operation: { op: "editors.list" },
        })
      ).result,
    ).toMatchObject({ kind: "editors", editors: [{ id: "code", command: join(root, "code") }] });
    const command = Command.parse({
      id: "open",
      deviceId: "desktop",
      payload: { type: "workspace.editor.open", threadId: thread.id, editorId: "code" },
    });
    expect(await runtime.execute(command)).toMatchObject({
      ok: true,
      editor: { editor: { id: "code" }, path: root },
    });
    expect(await runtime.execute(command)).toMatchObject({ ok: true, editor: { path: root } });
    expect(
      await runtime.execute(
        Command.parse({
          ...command,
          id: "missing",
          payload: {
            type: "workspace.script.run",
            threadId: thread.id,
            scriptId: "arbitrary:curl",
          },
        }),
      ),
    ).toMatchObject({ ok: false });
  } finally {
    await runtime.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("script discovery refuses a manifest symlink instead of reading outside the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-scripts-boundary-"));
  try {
    await writeFile(
      join(root, "outside.json"),
      JSON.stringify({ scripts: { stolen: "echo outside" } }),
    );
    await symlink(join(root, "outside.json"), join(root, "package.json"));
    await writeFile(join(root, "Procfile"), "web: echo web\n");
    await expect(listScripts(root)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
import { listScripts } from "./workspace-scripts.ts";

test("running a declared script returns an owned terminal with actual process output and exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-script-run-"));
  const store = new Store(join(root, "events.sqlite"));
  const workspaceId = store.createWorkspace(root, "Scripts");
  const thread = Thread.parse({
    id: "thread",
    workspaceId,
    provider: "codex",
    title: "Script",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  const runtime = new WorkspaceRuntime(store, root, () => 1000);
  try {
    await writeFile(
      join(root, "Procfile"),
      "verify: printf 'script reached process\\n' > reached.txt; cat reached.txt\n",
    );
    const result = await runtime.execute(
      Command.parse({
        id: "run",
        deviceId: "desktop",
        payload: { type: "workspace.script.run", threadId: thread.id, scriptId: "Procfile:verify" },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.terminalId) throw new Error("Expected terminal receipt");
    const attachment = runtime.terminal(result.terminalId, thread.id).attach({ fromOffset: 0 });
    let output = "",
      exited = false;
    try {
      for await (const event of attachment) {
        if (event.type === "data") output += event.data;
        if (event.type === "exit") {
          expect(event.status.code).toBe(0);
          exited = true;
          break;
        }
        if (event.type === "resync") throw new Error("Unexpected fixture overflow");
      }
    } finally {
      attachment.detach();
    }
    expect(output).toContain("script reached process");
    expect(await readFile(join(root, "reached.txt"), "utf8")).toBe("script reached process\n");
    expect(exited).toBe(true);
    expect(
      await runtime.execute(
        Command.parse({
          id: "run",
          deviceId: "desktop",
          payload: {
            type: "workspace.script.run",
            threadId: thread.id,
            scriptId: "Procfile:verify",
          },
        }),
      ),
    ).toMatchObject({ terminalId: result.terminalId });
  } finally {
    await runtime.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("editor discovery finds a macOS app without a PATH launcher", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-editor-bundle-"));
  const launcher = join(root, "Visual Studio Code.app/Contents/Resources/app/bin/code");
  await mkdir(join(root, "Visual Studio Code.app/Contents/Resources/app/bin"), { recursive: true });
  await writeFile(launcher, "#!/bin/sh\nexit 0\n");
  await chmod(launcher, 0o700);
  const store = new Store(join(root, "events.sqlite"));
  const runtime = new WorkspaceRuntime(store, root, () => 1000, {
    editorPath: "",
    platform: "darwin",
    editorApplications: [root],
  });
  try {
    expect(
      (
        await runtime.read({
          type: "workspace.request",
          requestId: "editors",
          operation: { op: "editors.list" },
        })
      ).result,
    ).toMatchObject({ kind: "editors", editors: [{ id: "code", command: launcher }] });
  } finally {
    await runtime.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
