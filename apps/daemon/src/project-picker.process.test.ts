import { mkdir, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command, ProjectsRequest, type ProjectsResult } from "@ace/protocol";
import { projectFixture, projectServer, until } from "./projects-test-support.ts";
import type { Client } from "./socket-test-support.ts";

let sequence = 0;
async function read(
  client: Client,
  operation: ProjectsRequest["operation"],
): Promise<ProjectsResult["result"]> {
  const requestId = `picker-${++sequence}`;
  client.send(ProjectsRequest.parse({ type: "projects.request", requestId, operation }));
  const result = await until(
    client,
    (message) => message.type === "projects.result" && message.requestId === requestId,
  );
  if (result.type !== "projects.result") throw new Error("Expected projects result");
  return result.result;
}
async function indexed(client: Client, query: string) {
  let result: ProjectsResult["result"];
  for (let attempt = 0; attempt < 40; attempt++) {
    result = await read(client, { op: "fs.search", query, limit: 100, showHidden: false });
    if (result.kind !== "search") throw new Error(JSON.stringify(result));
    if (!result.truncated) return result;
  }
  throw new Error("Small tree did not finish indexing");
}

test("folder search ranks names and recents, marks Git roots and excludes ignored descendants", async () => {
  const f = await projectFixture({ pickerClock: () => 1000 });
  const server = await projectServer(f);
  try {
    for (const name of [
      "ace",
      "ace-old",
      "ace-work",
      "a-c-e",
      "Code/other",
      "node_modules/ace",
      ".git/ace",
      "Library/ace",
      ".hidden/ace",
      "cache/ace",
    ])
      await mkdir(join(f.root, name), { recursive: true });
    await mkdir(join(f.root, "ace-work", ".git"));
    const client = await server.connect();
    client.send({
      type: "command",
      command: Command.parse({
        id: "register",
        deviceId: "owner",
        payload: { type: "workspace.add", path: join(f.root, "ace-old") },
      }),
    });
    expect(await until(client, (m) => m.type === "commandResult")).toMatchObject({ ok: true });
    const result = await indexed(client, "ace");
    expect(result.entries.slice(0, 3).map((entry) => entry.name)).toEqual([
      "ace",
      "ace-old",
      "ace-work",
    ]);
    expect(result.entries.map((entry) => entry.name)).toContain("a-c-e");
    expect(
      result.entries.some((entry) =>
        /\/(node_modules|Library|cache|\.git|\.hidden)\//.test(entry.path),
      ),
    ).toBe(false);
    expect(result.entries[1]).toMatchObject({ isProject: true, lastOpened: 1000, recentScore: 1 });
    expect(result.entries[2]).toMatchObject({ isGitRepo: true, isProject: false });
    const empty = await indexed(client, "");
    expect(empty.entries[0]?.name).toBe("ace-old");
    expect(await read(client, { op: "fs.recentFolders", limit: 20 })).toMatchObject({
      folders: [{ path: join(f.root, "ace-old") }],
    });
    const hidden = await read(client, {
      op: "fs.search",
      query: "hidden",
      limit: 100,
      showHidden: true,
    });
    expect(hidden).toMatchObject({
      kind: "search",
      entries: expect.arrayContaining([expect.objectContaining({ name: ".hidden" })]),
    });
  } finally {
    await server.close();
    await f.close();
  }
});

test("path completion preserves tilde, whitespace and the common prefix across undisplayed candidates", async () => {
  const f = await projectFixture();
  const server = await projectServer(f);
  try {
    for (const name of ["Code", "Configs", "Cool folder", ".concealed", "node_modules"])
      await mkdir(join(f.root, name));
    const client = await server.connect();
    const result = await read(client, {
      op: "fs.complete",
      path: "~/Co",
      limit: 1,
      showHidden: false,
    });
    expect(result).toMatchObject({
      kind: "completion",
      commonPrefix: "~/Co",
      truncated: true,
      candidates: [{ completion: "~/Code/", path: join(f.root, "Code") }],
    });
    expect(
      await read(client, { op: "fs.complete", path: "~/Cool", limit: 20, showHidden: false }),
    ).toMatchObject({ commonPrefix: "~/Cool folder/", candidates: [{ name: "Cool folder" }] });
    expect(
      await read(client, { op: "fs.complete", path: "~/", limit: 20, showHidden: false }),
    ).toMatchObject({
      candidates: expect.arrayContaining([expect.objectContaining({ name: "Code" })]),
    });
    const all = await read(client, { op: "fs.complete", path: "~/", limit: 20, showHidden: false });
    if (all.kind !== "completion") throw new Error("Expected completion");
    expect(all.candidates.map((candidate) => candidate.name)).toEqual([
      "Code",
      "Configs",
      "Cool folder",
    ]);
  } finally {
    await server.close();
    await f.close();
  }
});

test("cached search and completion refuse escaping links and changed allowed roots", async () => {
  let roots: string[] = [];
  const f = await projectFixture({ roots: async () => roots });
  const server = await projectServer(f);
  try {
    const allowed = join(f.root, "allowed");
    const outside = join(f.root, "outside");
    await mkdir(join(allowed, "project"), { recursive: true });
    await mkdir(outside);
    roots = [allowed];
    await symlink(outside, join(allowed, "escape"));
    const client = await server.connect();
    expect(
      await read(client, { op: "fs.complete", path: "~/", limit: 10, showHidden: false }),
    ).toMatchObject({ kind: "error", code: "outside_project_roots" });
    expect(
      await read(client, {
        op: "fs.complete",
        path: `${allowed}/esc`,
        limit: 10,
        showHidden: false,
      }),
    ).toMatchObject({ candidates: [] });
    expect(
      await read(client, {
        op: "fs.complete",
        path: `${allowed}/escape/`,
        limit: 10,
        showHidden: false,
      }),
    ).toMatchObject({ kind: "error", code: "outside_project_roots" });
    expect(
      await read(client, {
        op: "fs.complete",
        path: `${allowed}/../`,
        limit: 10,
        showHidden: false,
      }),
    ).toMatchObject({ kind: "error", code: "invalid_path" });
    expect((await indexed(client, "project")).entries).toHaveLength(1);
    await rm(join(allowed, "project"), { recursive: true });
    await symlink(outside, join(allowed, "project"));
    expect((await indexed(client, "project")).entries).toEqual([]);
    roots = [outside];
    expect((await indexed(client, "project")).entries).toEqual([]);
  } finally {
    await server.close();
    await f.close();
  }
});

test("superseding picker queries cancels the old request while other sockets remain independent", async () => {
  const f = await projectFixture();
  const server = await projectServer(f);
  try {
    await mkdir(join(f.root, "Code"));
    const client = await server.connect();
    const other = await server.connect({ deviceId: "another-owner" });
    for (const [requestId, query] of [
      ["old", "absent"],
      ["new", "Code"],
    ])
      client.send(
        ProjectsRequest.parse({
          type: "projects.request",
          requestId,
          operation: { op: "fs.search", query },
        }),
      );
    const replies = [
      await until(client, (m) => m.type === "projects.result"),
      await until(client, (m) => m.type === "projects.result"),
    ];
    expect(replies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: "old",
          result: { kind: "error", code: "search_cancelled" },
        }),
        expect.objectContaining({
          requestId: "new",
          result: expect.objectContaining({ kind: "search", query: "Code" }),
        }),
      ]),
    );
    expect((await indexed(other, "Code")).entries).toMatchObject([{ name: "Code" }]);
  } finally {
    await server.close();
    await f.close();
  }
});

test("clone helpers normalize GitHub shorthand and reject credentials and invalid destinations", async () => {
  const f = await projectFixture();
  const server = await projectServer(f);
  try {
    const client = await server.connect();
    for (const url of [
      "arpan404/ace",
      "https://github.com/arpan404/ace.git",
      "ssh://git@github.com/arpan404/ace.git",
      "git@github.com:arpan404/ace.git",
    ]) {
      const result = await read(client, { op: "workspace.clone.validate", url });
      expect(result).toMatchObject({ kind: "cloneUrl", name: "ace" });
      if (url === "arpan404/ace")
        expect(result).toMatchObject({ url: "https://github.com/arpan404/ace.git" });
    }
    for (const url of [
      "https://user:password@github.com/o/r",
      "file:///tmp/repo",
      "owner/..",
      "https://github.com/o/%2e%2e.git",
      "https://github.com/o/r?token=secret",
      "-repo/repo",
      "git@github.com:o/r?token=secret",
    ])
      expect(await read(client, { op: "workspace.clone.validate", url })).toMatchObject({
        kind: "error",
        code: "git_invalid_argument",
      });
  } finally {
    await server.close();
    await f.close();
  }
});

test("folder search refreshes new directories lazily after the cache expires", async () => {
  let clock = 1000;
  const f = await projectFixture({ pickerClock: () => clock });
  const server = await projectServer(f);
  try {
    await mkdir(join(f.root, "existing"));
    const client = await server.connect();
    expect((await indexed(client, "existing")).entries).toMatchObject([{ name: "existing" }]);
    await mkdir(join(f.root, "new-folder"));
    expect((await indexed(client, "new-folder")).entries).toEqual([]);
    clock += 30_001;
    expect((await indexed(client, "new-folder")).entries).toMatchObject([{ name: "new-folder" }]);
  } finally {
    await server.close();
    await f.close();
  }
});
