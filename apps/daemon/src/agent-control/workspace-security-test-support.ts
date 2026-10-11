import { mkdir, writeFile } from "node:fs/promises";
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
    permissionMode: "plan",
    workspaceId: h.store.createWorkspace(h.home, "project"),
    input: [{ type: "text", text: "Plan only" }],
  });
  if (!created.ok || !created.threadId) throw new Error("Caller missing");
  await h.engine.flush();
  return { h, markers, caller: h.caller(created.threadId) };
}
