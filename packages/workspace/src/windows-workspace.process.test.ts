import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type TestContext } from "vitest";
import { createWorkspace, PinnedDirectory, SafeRoot } from "./index.ts";
import { broadenParent, secureOwnerOnly } from "./windows-private-fixture.ts";

const win = test.runIf(process.platform === "win32");

async function fixture(onTestFinished: TestContext["onTestFinished"]) {
  const root = await mkdtemp(join(tmpdir(), "ace-windows-workspace-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

win(
  "reads, lists and searches Unicode files through the default Windows workspace",
  async ({ onTestFinished }) => {
    const root = await fixture(onTestFinished);
    await mkdir(join(root, "dossier-日本語"));
    await writeFile(join(root, "dossier-日本語", "café-✓.txt"), "first\nneedle 日本語\n");
    const workspace = await createWorkspace(root, { ripgrep: null });
    expect(await workspace.read({ path: "dossier-日本語/café-✓.txt" })).toMatchObject({
      text: "first\nneedle 日本語\n",
      binary: false,
    });
    const listed = await workspace.list({ dir: "dossier-日本語" });
    expect(listed.entries.map((entry) => entry.path)).toEqual(["dossier-日本語/café-✓.txt"]);
    const found = await workspace.search({ query: "needle", limit: 1 });
    expect(found.matches).toMatchObject([
      { path: "dossier-日本語/café-✓.txt", line: 2, preview: "needle 日本語" },
    ]);
    const safe = await SafeRoot.create(root);
    const { info } = await safe.metadata("dossier-日本語/café-✓.txt");
    expect(info.identity.kind).toBe("win32");
    expect(info.isFile()).toBe(true);
    expect(info.size).toBe(Buffer.byteLength("first\nneedle 日本語\n"));
  },
);

win("refuses an outside junction and a replaced workspace root", async ({ onTestFinished }) => {
  const base = await fixture(onTestFinished);
  const root = join(base, "root");
  const outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(root, "inside.txt"), "original");
  await writeFile(join(outside, "secret.txt"), "outside bytes");
  await symlink(outside, join(root, "escape"), "junction");
  const workspace = await createWorkspace(root);
  await expect(workspace.read({ path: "escape/secret.txt" })).rejects.toMatchObject({
    code: "PATH_ESCAPE",
  });
  await expect(workspace.list({ dir: "escape" })).rejects.toMatchObject({ code: "PATH_ESCAPE" });
  await rename(root, join(base, "moved"));
  await mkdir(root);
  await writeFile(join(root, "inside.txt"), "replacement");
  await expect(workspace.read({ path: "inside.txt" })).rejects.toMatchObject({
    code: "PATH_CHANGED",
  });
  expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("outside bytes");
});

win(
  "publishes private bytes despite public parent inheritance and refuses public private reads",
  async ({ onTestFinished }) => {
    const root = await fixture(onTestFinished);
    await broadenParent(root);
    await writeFile(join(root, "public.txt"), "public control");
    const directory = PinnedDirectory.atBoundary(root);
    try {
      expect(directory.readText("public.txt", 64)).toBe("public control");
      expect(() => directory.readPrivateText("public.txt", 64)).toThrow();
      await directory.writeExclusive("exclusive.txt", "exclusive secret");
      expect(directory.readPrivateText("exclusive.txt", 64)).toBe("exclusive secret");
      directory.publish("marker.json", "published secret");
      expect(directory.readPrivateText("marker.json", 64)).toBe("published secret");
      expect(() => directory.publish("marker.json", "must not replace")).toThrow();
      expect(directory.readPrivateText("marker.json", 64)).toBe("published secret");
      directory.replace("marker.json", "replacement secret");
      expect(directory.readPrivateText("marker.json", 64)).toBe("replacement secret");
      expect(directory.names().some((name) => name.endsWith(".pending"))).toBe(false);
      expect(await readFile(join(root, "public.txt"), "utf8")).toBe("public control");
    } finally {
      directory.closeSync();
    }
  },
);

win(
  "repairs private upload metadata on its held file after a pathname replacement",
  async ({ onTestFinished }) => {
    const root = await fixture(onTestFinished);
    const name = ".ace-upload-original";
    await writeFile(join(root, name), "original bytes");
    await secureOwnerOnly(join(root, name), "read");
    const safe = await SafeRoot.create(root);
    const { handle, verify } = await safe.privateFileMetadata(name);
    try {
      await rename(join(root, name), join(root, "held.txt"));
      await writeFile(join(root, name), "decoy bytes");
      await secureOwnerOnly(join(root, name), "read");
      handle.chmod(0o600);
      handle.checkPrivate(0);
      await expect(verify()).rejects.toMatchObject({ code: "PATH_CHANGED" });
      const directory = PinnedDirectory.atBoundary(root);
      try {
        expect(directory.readPrivateText("held.txt", 64)).toBe("original bytes");
        expect(() => directory.readPrivateText(name, 64)).toThrow();
      } finally {
        directory.closeSync();
      }
      expect(await readFile(join(root, name), "utf8")).toBe("decoy bytes");
    } finally {
      await handle.close();
    }
  },
);
