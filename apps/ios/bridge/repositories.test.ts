import "./test-host.ts";
import { afterEach, describe, expect, test } from "vitest";
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

async function machine() {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  daemon.projects.seedFolders("/home/dev", [{ path: "/home/dev/site", git: true }]);
  await client.start();
  await until(() => client.connectionState().getSnapshot() === "ready", "connected");
  const manage = new ProjectManage(client, schedule);
  const ask = (request: Parameters<ProjectManage["answer"]>[0]) =>
    manage.answer(request) as Promise<Record<string, unknown>>;
  return { daemon, client, ask };
}

describe("GitHub from the phone, through the machine's own gh", () => {
  test("the account's repositories are listed to clone, narrowed by a search", async () => {
    const { ask } = await machine();
    const context = await ask({ op: "repos.context" });
    expect(context).toMatchObject({ ok: true, ready: true });
    const all = await ask({
      op: "repos.list",
      host: String(context.host),
      account: String(context.account),
      query: "",
      visibility: "all",
      archived: "no",
      fork: "all",
    });
    expect(all.repositories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fullName: "ada/engine", private: true }),
        expect.objectContaining({ fullName: "ace-org/docs", private: false }),
      ]),
    );
    const docs = await ask({
      op: "repos.list",
      host: String(context.host),
      account: String(context.account),
      query: "docs",
      visibility: "all",
      archived: "no",
      fork: "all",
    });
    expect(docs.repositories).toEqual([expect.objectContaining({ fullName: "ace-org/docs" })]);
  });

  test("publishing a project with no commits creates its repository and says so", async () => {
    const { client, ask } = await machine();
    const added = await client.projects.add({ path: "/home/dev/site" });
    const workspaceId = added.workspace?.id;
    if (!workspaceId) throw new Error("no project");
    const before = await ask({ op: "publish.status", workspaceId, name: "site" });
    expect(before).toMatchObject({ ok: true, locked: false, publication: null });
    const published = await ask({ op: "publish", workspaceId, input: before.draft });
    expect(published).toMatchObject({
      ok: true,
      locked: true,
      publication: { phase: "empty", fullName: "ada/site", url: "https://github.com/ada/site" },
    });
  });
});
