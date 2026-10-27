import "./test-host.ts";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { facts } from "@ace/fake-daemon";
import { ThreadId, WorkspaceId } from "@ace/protocol";
import { ProjectManage, type ProjectManageOwner } from "./project-manage.ts";
import { NativeServices } from "./native-services.ts";
import { RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

const web = WorkspaceId.parse("web");
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
  daemon.createThread({ id: "t1", workspaceId: web, title: "Fix checkout", provider: "codex" });
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
    const refused = await manage.answer({ op: "remove", workspaceId: web, stopRunning: false });
    expect(refused).toEqual({
      ok: false,
      code: "workspace_threads_running",
      message: "Threads in this project are still running.",
    });
    expect(daemon.projects.get("web")).toBeDefined();
    const removed = await manage.answer({ op: "remove", workspaceId: web, stopRunning: true });
    expect(removed).toEqual({ ok: true, queued: false });
    expect(daemon.projects.get("web")).toBeUndefined();
  });

  test("defaults offer the machine's local branches", async () => {
    const { manage } = await machine();
    const options = await manage.answer({ op: "options", workspaceId: web, current: {} });
    expect(options).toMatchObject({ ok: true, git: true });
    expect((options as { branches: string[] }).branches).toContain("main");
  });
});

const roots = async (manage: ProjectManage) =>
  ((await manage.answer({ op: "roots" })) as { folders: { path: string }[] }).folders.map(
    (folder) => folder.path,
  );

describe("the folders a machine may open projects in", () => {
  test("allowing a folder under ~ adds the machine's own path to its project folders", async () => {
    const { daemon, manage } = await machine();
    daemon.projects.seedFolders("/Users/dev", [{ path: "/Users/dev/code" }]);
    expect(await manage.answer({ op: "allowFolder", path: "~/code", create: false })).toEqual({
      ok: true,
      queued: false,
    });
    expect(await roots(manage)).toContain("/Users/dev/code");
  });

  test("a missing folder is offered for creating, then created and allowed", async () => {
    const { daemon, manage } = await machine();
    daemon.projects.seedFolders("/Users/dev", []);
    const missing = await manage.answer({
      op: "allowFolder",
      path: "/Users/dev/new",
      create: false,
    });
    expect(missing).toMatchObject({
      ok: false,
      code: "directory_missing",
      canCreate: true,
      name: "new",
    });
    await manage.answer({ op: "allowFolder", path: "/Users/dev/new", create: true });
    expect(await roots(manage)).toContain("/Users/dev/new");
  });

  test("a folder that is no longer allowed leaves the list", async () => {
    const { daemon, manage } = await machine();
    daemon.projects.seedFolders("/Users/dev", [{ path: "/Users/dev/code" }]);
    await manage.answer({ op: "allowFolder", path: "/Users/dev/code", create: false });
    await manage.answer({ op: "removeFolder", path: "/Users/dev/code" });
    expect(await roots(manage)).not.toContain("/Users/dev/code");
  });

  test("a relative path is refused before anything is sent", async () => {
    const { manage } = await machine();
    expect(await manage.answer({ op: "allowFolder", path: "code", create: false })).toMatchObject({
      ok: false,
      code: "invalid_path",
    });
  });
});

describe("opening a project on the machine running ace", () => {
  test("the machine's editors and file manager are offered, and opening one opens it there", async () => {
    const { daemon, manage } = await machine();
    daemon.workspace.setEditors([{ id: "code", name: "Visual Studio Code", command: "/bin/code" }]);
    expect(await manage.answer({ op: "openers" })).toEqual({
      ok: true,
      editors: [{ id: "code", name: "Visual Studio Code" }],
      fileManager: "Finder",
    });
    const opened = await manage.answer({
      op: "open",
      app: { kind: "editor", editorId: "code" },
      workspaceId: web,
      path: "src/queue.ts",
      line: 4,
    });
    expect(opened).toEqual({ ok: true });
    expect(daemon.workspace.opened).toEqual([
      { app: "code", folder: "web", path: "src/queue.ts", line: 4 },
    ]);
  });

  test("an editor the machine doesn't have is refused in words", async () => {
    const { manage } = await machine();
    expect(
      await manage.answer({
        op: "open",
        app: { kind: "editor", editorId: "zed" },
        workspaceId: web,
      }),
    ).toEqual({
      ok: false,
      code: "editor_not_found",
      message: "That editor isn't installed on the machine any more.",
    });
  });
});

describe("a thread's project scripts", () => {
  const t1 = ThreadId.parse("t1");
  test("scripts are listed with the file that configures them, and running one opens its terminal", async () => {
    const { manage } = await machine();
    const listed = (await manage.answer({ op: "scripts", threadId: t1 })) as {
      scripts: { id: string; name: string; running: boolean }[];
      files: string[];
    };
    expect(listed.files).toEqual(["package.json"]);
    expect(listed.scripts.map((script) => script.name)).toEqual([
      "dev",
      "test",
      "build",
      "typecheck",
    ]);
    const ran = await manage.answer({
      op: "runScript",
      threadId: t1,
      scriptId: "package.json:dev",
    });
    expect(ran).toMatchObject({ ok: true, reused: false, terminalId: expect.any(String) });
    const again = (await manage.answer({ op: "scripts", threadId: t1 })) as typeof listed;
    expect(again.scripts.find((script) => script.name === "dev")?.running).toBe(true);
  });

  test("running a script whose terminal still runs goes back to that terminal", async () => {
    const { manage } = await machine();
    const first = (await manage.answer({
      op: "runScript",
      threadId: t1,
      scriptId: "package.json:dev",
    })) as {
      terminalId: string;
    };
    expect(
      await manage.answer({ op: "runScript", threadId: t1, scriptId: "package.json:dev" }),
    ).toEqual({
      ok: true,
      terminalId: first.terminalId,
      reused: true,
    });
  });
});

describe("a thread's dev servers", () => {
  test("detected dev servers are offered once each, to open in the thread's browser", async () => {
    const { manage } = await machine();
    const found = (await manage.answer({ op: "previews", threadId: ThreadId.parse("t1") })) as {
      previews: { port: number; url: string; title: string }[];
    };
    expect(found.previews).toEqual([
      { port: 5173, url: "http://localhost:5173/", title: "Vite + React + TS" },
      { port: 3000, url: "http://localhost:3000/", title: "Next.js" },
    ]);
  });
});

/**
 * The real client, except each command's receipt reaches the bridge only once the test
 * releases it: the computer answering after the bridge stopped waiting.
 */
function late(client: ReturnType<typeof sheetFixture>["client"]) {
  const held: (() => void)[] = [];
  let released = false;
  const owner: ProjectManageOwner = {
    request: client.request.bind(client),
    enqueue: client.enqueue.bind(client),
    commandId: client.commandId.bind(client),
    intent: (id) => {
      const real = client.intent(id);
      return {
        getSnapshot: () => (released ? real.getSnapshot() : undefined),
        subscribe: (listener: () => void) => {
          held.push(listener);
          return real.subscribe(() => {
            if (released) listener();
          });
        },
      } as ReturnType<ProjectManageOwner["intent"]>;
    },
  };
  const release = () => {
    released = true;
    for (const listener of held) listener();
  };
  return { owner, release };
}

/** The wait for a receipt runs out at once. */
const impatient = (_delay: number, run: () => void) => {
  run();
  return () => {};
};

describe("a write the computer answers late", () => {
  test("a removal refused after the wait still reaches the phone with its reason", async () => {
    const { daemon, client } = sheetFixture();
    closers.push(() => client.close());
    daemon.createThread({ id: "t1", workspaceId: web, title: "Fix checkout", provider: "codex" });
    daemon.apply("t1", [facts.rootAgent("codex"), facts.turn("root")]);
    await client.start();
    await until(() => client.connectionState().getSnapshot() === "ready", "connected");
    const { owner, release } = late(client);
    const manage = new ProjectManage(owner, impatient);
    const first = (await manage.answer({ op: "remove", workspaceId: web, stopRunning: false })) as {
      writeId: string;
    };
    expect(first).toMatchObject({ ok: true, queued: true, writeId: expect.any(String) });
    const outcome = manage.answer({ op: "outcome", writeId: first.writeId });
    // Give the daemon time to answer, then let its receipt through.
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    expect(await outcome).toEqual({
      ok: false,
      code: "workspace_threads_running",
      message: "Threads in this project are still running.",
    });
    expect(daemon.projects.get("web")).toBeDefined();
  });
});

describe("polling for a late write's answer", () => {
  test("polls the phone stopped waiting on let go, so the request cap is never reached", async () => {
    const { daemon, client } = sheetFixture();
    closers.push(() => client.close());
    daemon.createThread({ id: "t1", workspaceId: web, title: "Fix checkout", provider: "codex" });
    daemon.apply("t1", [facts.rootAgent("codex"), facts.turn("root")]);
    await client.start();
    await until(() => client.connectionState().getSnapshot() === "ready", "connected");
    const { owner, release } = late(client);
    const sink = new RecordingSink();
    const services = new NativeServices(
      client,
      sink,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new ProjectManage(owner, impatient),
    );
    const ask = async (id: string, request: Record<string, unknown>) => {
      services.handle({ type: "service", id, request: { type: "native.project", request } });
    };
    const reply = (id: string) => sink.read(`service:${id}`);
    await ask("remove", { op: "remove", workspaceId: web, stopRunning: false });
    await until(() => reply("remove") !== undefined, "queued");
    const queued = z.object({ writeId: z.string() }).parse(reply("remove")?.value);
    const writeId = queued.writeId;
    // The phone's native timeout cancels each poll; more of them than the bridge's 32 slots.
    for (let poll = 0; poll < 40; poll++) {
      const id = `poll-${poll}`;
      await ask(id, { op: "outcome", writeId });
      services.handle({ type: "service.cancel", id });
      await until(() => reply(id) !== undefined, `poll ${poll} answered`);
      expect(reply(id)?.message).not.toContain("Too many requests");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await ask("last", { op: "outcome", writeId });
    await until(() => reply("last") !== undefined, "last poll answered");
    expect(reply("last")?.value).toMatchObject({ ok: false, code: "workspace_threads_running" });
    services.dispose();
  });
});
