import { mkdir, stat, writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { once } from "node:events";
import { z } from "zod";
import { expect, test } from "vitest";
import { Project } from "@ace/protocol";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { invoke } from "./cli-test-support.ts";

test.each(["missing", "stale"])(
  "ace open starts a real local daemon with %s endpoint files",
  async (endpoint) => {
    const root = await mkdtemp(join(tmpdir(), "ace-open-start-"));
    const home = join(root, "daemon"),
      folder = join(root, "project"),
      bin = join(root, "bin");
    await mkdir(folder);
    await mkdir(bin);
    if (endpoint === "stale") {
      await mkdir(home, { mode: 0o700 });
      const abandoned = createServer();
      abandoned.listen(0, "127.0.0.1");
      await once(abandoned, "listening");
      const address = abandoned.address();
      if (!address || typeof address === "string") throw new Error("Missing stale endpoint port");
      await new Promise<void>((resolve, reject) =>
        abandoned.close((error) => (error ? reject(error) : resolve())),
      );
      await writeFile(join(home, "daemon-endpoint"), `http://127.0.0.1:${address.port}/`, {
        mode: 0o600,
      });
      await writeFile(join(home, "daemon-token"), "a".repeat(64), { mode: 0o600 });
    }
    for (const name of ["open", "xdg-open"])
      await writeFile(join(bin, name), `#!${process.execPath}\nprocess.exit(0);\n`, {
        mode: 0o700,
      });
    const env = {
      HOME: root,
      PATH: bin,
      ACE_PORT: "0",
      ACE_LISTEN: "local",
      ACE_LOG_LEVEL: "silent",
      ACE_MODEL_INSTANCES: "[]",
      ACE_HISTORY_INSTANCES: "[]",
      ACE_WORKSPACE_ROOT: "",
      ACE_DEV: "0",
      ACE_VERSION: "development",
      ACE_ACCOUNTS_DB: join(home, "accounts.sqlite"),
    };
    try {
      const opened = await invoke(
        home,
        ["open", folder, "--web", "--json", "--timeout", "20s"],
        "",
        env,
      );
      expect(opened.code, opened.stderr).toBe(0);
      expect(JSON.parse(opened.stdout)).toMatchObject({
        accepted: true,
        project: { path: folder },
      });
      const listed = await invoke(home, ["project", "list", "--json"], "", env);
      expect(listed.code, listed.stderr).toBe(0);
      expect(JSON.parse(listed.stdout)).toMatchObject({
        projects: [expect.objectContaining({ path: folder })],
      });
    } finally {
      await invoke(home, ["stop", "--json", "--timeout", "10s"], "", env);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("project CLI registration, paging, rename and removal use the daemon catalog and preserve folders", async () => {
  const f = await daemonFixture();
  try {
    await f.daemon.settings.set("projects.roots", [f.h.home], { kind: "global" });
    const home = join(f.h.home, "daemon");
    const folder = join(f.h.home, "empty-project");
    await mkdir(folder);
    const created = await invoke(home, ["add", folder, "--idempotency-key", "add-once", "--json"]);
    expect(created.code, created.stderr).toBe(0);
    const project = z.object({ workspace: Project }).parse(JSON.parse(created.stdout)).workspace;
    const retried = await invoke(home, ["add", folder, "--idempotency-key", "add-once", "--json"]);
    expect(JSON.parse(retried.stdout).workspace.id).toBe(project.id);
    const renamed = await invoke(home, [
      "project",
      "rename",
      project.id,
      "Renamed project",
      "--json",
    ]);
    expect(renamed.code, renamed.stderr).toBe(0);
    const projects: z.infer<typeof Project>[] = [];
    let after: string | null = null;
    do {
      const page = await invoke(home, [
        "project",
        "list",
        "--limit",
        "1",
        ...(after ? ["--after", after] : []),
        "--json",
      ]);
      expect(page.code, page.stderr).toBe(0);
      const result = z
        .object({ projects: z.array(Project), next: z.string().nullable() })
        .parse(JSON.parse(page.stdout));
      projects.push(...result.projects);
      after = result.next;
    } while (after);
    expect(projects.filter((entry) => entry.id === project.id)).toEqual([
      { ...project, name: "Renamed project" },
    ]);
    const removed = await invoke(home, ["project", "remove", project.id, "--json"]);
    expect(removed.code, removed.stderr).toBe(0);
    expect((await stat(folder)).isDirectory()).toBe(true);
    const listed = await invoke(home, ["project", "list", "--json"]);
    expect(
      JSON.parse(listed.stdout).projects.map((entry: z.infer<typeof Project>) => entry.id),
    ).not.toContain(project.id);
    const restored = await invoke(home, ["project", "add", folder, "--json"]);
    expect(JSON.parse(restored.stdout).workspace.id).toBe(project.id);
  } finally {
    await f.daemon.close();
  }
});

test("ace open dispatches the registered project to the OS opener without credentials in its URL", async () => {
  const f = await daemonFixture();
  try {
    await f.daemon.settings.set("projects.roots", [f.h.home], { kind: "global" });
    const bin = join(f.h.home, "open-bin");
    await mkdir(bin);
    const marker = join(bin, "opened.json");
    for (const name of ["open", "xdg-open"])
      await writeFile(
        join(bin, name),
        `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n`,
        { mode: 0o700 },
      );
    const output = await invoke(
      join(f.h.home, "daemon"),
      ["open", f.h.home, "--web", "--json"],
      "",
      { PATH: bin },
    );
    expect(output.code, output.stderr).toBe(0);
    const result = z
      .object({ accepted: z.literal(true), target: z.url(), project: Project })
      .parse(JSON.parse(output.stdout));
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual([result.target]);
    const url = new URL(result.target);
    expect(url.pathname).toBe("/new");
    expect(url.searchParams.get("project")).toBe(result.project.id);
    expect(url.hash).toBe("");
    expect(url.username + url.password).toBe("");
  } finally {
    await f.daemon.close();
  }
});
