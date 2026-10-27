import "./test-host.ts";
import { afterEach, describe, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import { ProjectManage } from "./project-manage.ts";
import { sheetFixture, until } from "./sheet-fixture.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const schedule = (delay: number, run: () => void) => {
  const timer = setTimeout(run, delay);
  return () => clearTimeout(timer);
};

/** A machine with one project, `web`, whose only thread is still working. */
async function machine() {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  daemon.createThread({ id: "t1", workspaceId: "web", title: "Fix checkout", provider: "codex" });
  daemon.apply("t1", [facts.rootAgent("codex"), facts.turn("root")]);
  await client.start();
  await until(() => client.connectionState().getSnapshot() === "ready", "connected");
  const project = daemon.projects.get("web");
  if (!project) throw new Error("no project");
  return { daemon, manage: new ProjectManage(client, schedule), project };
}

describe("managing a project from the phone", () => {
  test("a saved edit renames the project and gives it a glyph on the machine", async () => {
    const { daemon, manage, project } = await machine();
    const outcome = await manage.answer({
      op: "save",
      project,
      draft: {
        name: "Storefront",
        icon: { mode: "glyph", glyph: "rocket", color: "green" },
        notes: [{ text: "tests use bun run test" }],
      },
    });
    expect(outcome).toEqual({ ok: true, queued: false });
    expect(daemon.projects.get("web")).toMatchObject({
      name: "Storefront",
      badge: { color: "green", glyph: "rocket" },
      notes: [{ text: "tests use bun run test" }],
    });
  });

  test("an edit with nothing changed sends nothing and succeeds", async () => {
    const { daemon, manage, project } = await machine();
    const outcome = await manage.answer({ op: "save", project, draft: { name: project.name } });
    expect(outcome).toEqual({ ok: true, queued: false });
    expect(daemon.projects.get("web")).toEqual(project);
  });

  test("a name the daemon would refuse is refused on the phone with the reason", async () => {
    const { manage, project } = await machine();
    expect(await manage.answer({ op: "save", project, draft: { name: "a/b" } })).toEqual({
      ok: false,
      code: "invalid",
      message: "A name can't contain / or \\.",
    });
  });

  test("new-thread defaults are saved for the project", async () => {
    const { daemon, manage, project } = await machine();
    const defaults = { access: "ask", worktree: false, checkCommand: "bun run check" };
    await manage.answer({ op: "save", project, draft: { name: project.name, defaults } });
    expect(daemon.projects.get("web")?.defaults).toEqual(defaults);
  });

  test("removing a project with a running thread is refused until the person stops them", async () => {
    const { daemon, manage } = await machine();
    const refused = await manage.answer({ op: "remove", workspaceId: "web", stopRunning: false });
    expect(refused).toEqual({
      ok: false,
      code: "workspace_threads_running",
      message: "Threads in this project are still running.",
    });
    expect(daemon.projects.get("web")).toBeDefined();
    const removed = await manage.answer({ op: "remove", workspaceId: "web", stopRunning: true });
    expect(removed).toEqual({ ok: true, queued: false });
    expect(daemon.projects.get("web")).toBeUndefined();
  });

  test("defaults offer the machine's local branches", async () => {
    const { manage } = await machine();
    const options = await manage.answer({ op: "options", workspaceId: "web", current: {} });
    expect(options).toMatchObject({ ok: true, git: true });
    expect((options as { branches: string[] }).branches).toContain("main");
  });
});
