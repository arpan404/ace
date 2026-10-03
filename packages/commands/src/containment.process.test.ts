import {
  mkdtemp,
  mkdir,
  rm,
  realpath,
  writeFile,
  rename,
  symlink,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { expect, it } from "vitest";
import { CommandCatalog, CommandFiles, SecureCommandIo, openCommandChild } from "./index.ts";
const target = { provider: "claude", instance: "personal", session: "test" } as const;
const controlled = { watch: () => () => {}, schedule: () => () => {} };
it("never imports outside bytes when a pinned parent is replaced by a symlink before leaf open", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-command-containment-")));
  const root = join(home, "prompts"),
    parent = join(root, "nested"),
    outside = join(home, "outside");
  await mkdir(parent, { recursive: true });
  await mkdir(outside);
  await writeFile(join(parent, "item.md"), "Authorized");
  await writeFile(join(outside, "item.md"), "Outside secret");
  let armed = false;
  const io = new SecureCommandIo(async (fd, name, flags) => {
    if (armed && basename(name) === "item.md") {
      armed = false;
      await rename(parent, join(root, "saved"));
      await symlink(outside, parent);
    }
    return openCommandChild(fd, name, flags);
  });
  const catalog = new CommandCatalog(() => 0);
  const files = new CommandFiles(
    catalog,
    [{ path: root, trustedRoot: home, format: "library", scope: "user" }],
    { ...controlled, io },
  );
  try {
    await files.start();
    const command = catalog.list(target, "nested:item").commands[0];
    if (!command) throw new Error("Missing authorized snippet");
    await writeFile(join(parent, "item.md"), "Authorized edit");
    armed = true;
    files.invalidate(join(parent, "item.md"));
    await files.flush();
    expect(await readFile(join(parent, "item.md"), "utf8")).toBe("Outside secret");
    const result = catalog.resolve(target, command.id);
    if (result.ok)
      expect(result.plan).toEqual({ kind: "prompt", provider: "claude", text: "Authorized edit" });
    else expect(result.error).toBe("not_found");
  } finally {
    await files.close();
    await rm(home, { recursive: true, force: true });
  }
});
it("directory additions do not reread surviving snippets and recovery limits enumeration per batch", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-command-churn-")));
  const root = join(home, "prompts");
  await mkdir(root);
  for (let i = 0; i < 600; i++) await writeFile(join(root, `${i}.md`), "Existing body");
  const catalog = new CommandCatalog(() => 0);
  const files = new CommandFiles(
    catalog,
    [{ path: root, format: "library", scope: "user" }],
    controlled,
  );
  try {
    await files.start();
    const before = files.metrics();
    await writeFile(join(root, "added.md"), "Added body");
    files.invalidate(root);
    await files.reconcile();
    expect(files.metrics().directoryEntries - before.directoryEntries).toBeLessThanOrEqual(32);
    await files.flush();
    expect(files.metrics().readBytes - before.readBytes).toBe(Buffer.byteLength("Added body"));
    expect(files.metrics().fileReads - before.fileReads).toBe(1);
    const added = catalog.list(target, "added").commands[0];
    if (!added) throw new Error("Missing added snippet");
    expect(catalog.resolve(target, added.id)).toEqual({
      ok: true,
      plan: { kind: "prompt", provider: "claude", text: "Added body" },
    });
    expect(catalog.list(target, "0", 100).commands.some((c) => c.name === "0")).toBe(true);
  } finally {
    await files.close();
    await rm(home, { recursive: true, force: true });
  }
});
