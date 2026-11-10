import "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import { WorkspaceId } from "@ace/protocol";
import { ProjectManage } from "./project-manage.ts";
import { sheetFixture, until } from "./sheet-fixture.ts";

/*
 * A project's repositories edited from the phone's project settings (ADR 0116), against the fake
 * daemon's `ace` project: `origin` on GitHub and `mirror` on GitLab. Each change is asserted by
 * what the daemon then lists.
 */

const ace = WorkspaceId.parse("ace");
const github = { forge: "github", host: "github.com", owner: "acme", name: "ace" } as const;
const gitlab = { forge: "gitlab", host: "gitlab.com", owner: "acme", name: "ace" } as const;

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const schedule = (delay: number, run: () => void) => {
  const timer = setTimeout(run, delay);
  return () => clearTimeout(timer);
};

interface Row {
  label: string;
  line: string;
  primary: boolean;
  visible: boolean;
  canMakePrimary: boolean;
  canRemove: boolean;
}

/** `between` runs once, after the phone's next read of the project's repositories. */
async function machine(between?: (daemon: ReturnType<typeof sheetFixture>["daemon"]) => void) {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  daemon.projects.repositories.addMirror(ace);
  daemon.createThread({ id: "t1", workspaceId: ace, title: "Mirror", provider: "codex" });
  daemon.apply("t1", [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
  await client.start();
  await until(() => client.connectionState().getSnapshot() === "ready", "connected");
  let pending = between;
  const owner: ConstructorParameters<typeof ProjectManage>[0] = {
    request: (async (input: Parameters<typeof client.request>[0], options) => {
      const reply = await client.request(input, options);
      const run = pending;
      if (run && input.type === "workspace.request") {
        pending = undefined;
        run(daemon);
      }
      return reply;
    }) as typeof client.request,
    enqueue: client.enqueue.bind(client),
    intent: client.intent.bind(client),
    commandId: client.commandId.bind(client),
  };
  const manage = new ProjectManage(owner, schedule);
  const rows = async () =>
    ((await manage.answer({ op: "repositories.read", workspaceId: ace })) as { rows: Row[] }).rows;
  const change = (kind: "primary" | "hide" | "show" | "remove", repository: object) =>
    manage.answer({
      op: "repositories.change",
      workspaceId: ace,
      change: kind,
      repository,
    } as never);
  const add = (address: string) =>
    manage.answer({ op: "repositories.add", workspaceId: ace, address });
  return { rows, change, add, daemon };
}

const shown = (rows: Row[]) =>
  rows.map((row) => `${row.label} | ${row.line}${row.primary ? " | Primary" : ""}`);

test("the project's remotes are listed with where they come from, origin primary", async () => {
  const { rows } = await machine();
  expect(shown(await rows())).toEqual([
    "GitHub · acme/ace | Remote origin | Primary",
    "GitLab · acme/ace | Remote mirror",
  ]);
});

test("making the mirror primary and hiding origin is what the project lists next", async () => {
  const { rows, change } = await machine();
  expect(await change("primary", gitlab)).toMatchObject({ ok: true });
  expect(await change("hide", github)).toMatchObject({ ok: true });
  expect(shown(await rows())).toEqual([
    "GitHub · acme/ace | Remote origin · Hidden",
    "GitLab · acme/ace | Remote mirror | Primary",
  ]);
  // Showing it again keeps the mirror primary.
  await change("show", github);
  expect(shown(await rows())).toEqual([
    "GitHub · acme/ace | Remote origin",
    "GitLab · acme/ace | Remote mirror | Primary",
  ]);
});

test("a repository added by its SSH address is listed as added by hand and can be removed", async () => {
  const { rows, change, add } = await machine();
  expect(await add(" git@github.com:acme/api.git ")).toMatchObject({ ok: true });
  const added = (await rows()).find((row) => row.label === "GitHub · acme/api");
  expect(added).toMatchObject({ line: "Added by hand", canRemove: true });
  expect(await change("remove", { ...github, name: "api" })).toMatchObject({ ok: true });
  expect((await rows()).map((row) => row.label)).not.toContain("GitHub · acme/api");
});

test("an address on a host that isn't configured is refused in words and saves nothing", async () => {
  const { rows, add } = await machine();
  const before = await rows();
  expect(await add("https://git.example.com/acme/api")).toEqual({
    ok: false,
    code: "invalid",
    message:
      "git.example.com isn't one of your Git hosts. Add it in Settings under Source control first.",
  });
  expect(await add("not an address")).toMatchObject({ ok: false });
  expect(await rows()).toEqual(before);
});

test("adding a repository the project already uses says so", async () => {
  const { add } = await machine();
  expect(await add("https://gitlab.com/acme/ace.git")).toMatchObject({
    ok: false,
    message: "GitLab · acme/ace is already in this project.",
  });
});

test("hiding the primary clears it, and the next visible repository becomes primary", async () => {
  const { rows, change } = await machine();
  await change("hide", github);
  const listed = await rows();
  expect(listed.find((row) => row.primary)?.label).toBe("GitLab · acme/ace");
  expect(listed.find((row) => row.label === "GitHub · acme/ace")).toMatchObject({
    visible: false,
    canMakePrimary: true,
  });
});

test("the phone's edit is re-applied to choices saved elsewhere since it read them", async () => {
  const { change, daemon } = await machine((fake) => {
    fake.projects.repositories.set(ace, { added: [], hidden: [gitlab], primary: null });
  });
  expect(await change("primary", github)).toMatchObject({ ok: true });
  expect(daemon.projects.repositories.read(ace).config).toEqual({
    added: [],
    hidden: [gitlab],
    primary: github,
  });
});
