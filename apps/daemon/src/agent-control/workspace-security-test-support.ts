import { mkdir, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { repository, git } from "../thread-creation-test-support.ts";
import { shellQuote } from "../workspace-scripts.ts";
import { setup } from "./test-support.ts";

export async function hostileWorkspace() {
  const h = setup();
  await repository(h.home);
  const markers = ["filter", "lfs", "hook", "fsmonitor", "setup"].map((name) =>
    join(h.home, `${name}-executed`),
  );
  for (const [index, name] of ["filter", "lfs", "hook", "fsmonitor", "setup"].entries()) {
    const marker = markers[index];
    if (!marker) throw new Error("Marker missing");
    await writeFile(
      join(h.home, `${name}.cjs`),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n` +
        (name === "filter"
          ? "process.stdin.pipe(process.stdout);\n"
          : name === "fsmonitor"
            ? "process.stdout.write('token\\0');\n"
            : ""),
    );
  }
  await writeFile(
    join(h.home, ".gitattributes"),
    "filtered.txt filter=hostile\nlfs.txt filter=lfs\n",
  );
  await writeFile(join(h.home, "filtered.txt"), "Raw selected-ref bytes\n");
  await writeFile(join(h.home, "lfs.txt"), "Unexpanded LFS pointer\n");
  await writeFile(join(h.home, "Procfile"), `setup: ${shellQuote(process.execPath)} setup.cjs\n`);
  await git("git", ["-C", h.home, "add", "."]);
  await git("git", [
    "-C",
    h.home,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@ace.local",
    "commit",
    "-m",
    "Hostile selected ref",
  ]);
  const hooks = join(h.home, ".hostile-hooks");
  await mkdir(hooks);
  for (const name of ["post-checkout", "post-index-change", "reference-transaction"])
    await writeFile(
      join(hooks, name),
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(h.home, "hook.cjs"))}\n`,
      { mode: 0o755 },
    );
  const settings = [
    ["core.hooksPath", hooks],
    [
      "core.fsmonitor",
      `${shellQuote(process.execPath)} ${shellQuote(join(h.home, "fsmonitor.cjs"))}`,
    ],
    [
      "filter.hostile.smudge",
      `${shellQuote(process.execPath)} ${shellQuote(join(h.home, "filter.cjs"))}`,
    ],
    [
      "filter.hostile.clean",
      `${shellQuote(process.execPath)} ${shellQuote(join(h.home, "filter.cjs"))}`,
    ],
    ["filter.hostile.required", "true"],
    [
      "filter.lfs.process",
      `${shellQuote(process.execPath)} ${shellQuote(join(h.home, "lfs.cjs"))}`,
    ],
    ["filter.lfs.required", "true"],
  ];
  for (const [key, value] of settings) {
    if (!key || !value) throw new Error("Setting missing");
    await git("git", ["-C", h.home, "config", key, value]);
  }
  await h.catalog.refresh();
  const created = h.service.command("plan-caller", {
    type: "thread.create",
    provider: "claude",
    access: "read-only",
    workspaceId: h.store.createWorkspace(h.home, "project"),
    input: [{ type: "text", text: "Plan only" }],
  });
  if (!created.ok || !created.threadId) throw new Error("Caller missing");
  await h.engine.flush();
  return { h, markers, caller: h.caller(created.threadId) };
}

/** Real Git object omission with a hostile promisor transport; provider execution stays scripted. */
export async function partialCloneWorkspace() {
  const h = setup();
  await repository(h.home);
  const marker = join(h.home, "lazy-fetch-executed");
  const script = join(h.home, "hostile-ssh.cjs");
  await writeFile(
    script,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); process.exit(1);\n`,
  );
  const { stdout } = await git("git", ["-C", h.home, "rev-parse", "HEAD:file.txt"]);
  const blob = stdout.trim();
  for (const [key, value] of [
    ["core.repositoryformatversion", "1"],
    ["extensions.partialClone", "origin"],
    ["remote.origin.url", "ssh://example.invalid/objects.git"],
    ["remote.origin.promisor", "true"],
    ["remote.origin.partialclonefilter", "blob:none"],
    ["core.sshCommand", `${shellQuote(process.execPath)} ${shellQuote(script)}`],
  ]) {
    if (!key || !value) throw new Error("Partial-clone setting missing");
    await git("git", ["-C", h.home, "config", key, value]);
  }
  await rm(join(h.home, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  await h.catalog.refresh();
  const result = h.service.command("plan-caller", {
    type: "thread.create",
    provider: "claude",
    access: "read-only",
    workspaceId: h.store.createWorkspace(h.home, "project"),
    input: [{ type: "text", text: "Plan only" }],
  });
  if (!result.ok || !result.threadId) throw new Error("Caller missing");
  await h.engine.flush();
  return { h, caller: h.caller(result.threadId), marker };
}

export async function addLocalRemote(project: string) {
  const remote = join(project, "remote.git");
  await git("git", ["init", "--bare", remote]);
  await git("git", ["-C", project, "remote", "add", "origin", pathToFileURL(remote).href]);
  return remote;
}
