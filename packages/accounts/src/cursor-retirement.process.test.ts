import { mkdtemp, rm, symlink, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { createInstance, openRegistry } from "./index.ts";

test("retiring an implicit Cursor CLI account never traverses its home or changes editor files", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-retirement-"));
  const path = join(root, "accounts.sqlite");
  const editor = join(root, "editor", ".cursor");
  await mkdir(editor, { recursive: true });
  await writeFile(join(editor, "sentinel"), "untouched editor home");
  const alias = join(root, "old-home");
  await symlink(editor, alias);
  let registry = await openRegistry(path);
  await registry.register(
    createInstance({
      id: "cursor-sdk-default",
      provider: "cursor",
      label: "Cursor",
      homeDir: join(root, "sdk"),
    }),
  );
  registry.close();
  const db = new DatabaseSync(path);
  try {
    db.prepare("INSERT INTO accounts VALUES (?,?,?)").run(
      "cursor-cli-default",
      JSON.stringify({
        id: "cursor-cli-default",
        provider: "cursor",
        label: "Old CLI",
        homeDir: alias,
        env: {},
        implicit: true,
      }),
      JSON.stringify({}),
    );
    db.prepare("INSERT INTO account_selection VALUES (?,?)").run(
      "provider:cursor",
      "cursor-cli-default",
    );
  } finally {
    db.close();
  }
  try {
    registry = await openRegistry(path);
    expect(registry.list().map(({ instance }) => instance.id)).toEqual(["cursor-sdk-default"]);
    expect(registry.summary("cursor-sdk-default", 1)?.isDefault).toBe(true);
    registry.selectProvider("cursor", "cursor-cli-default");
    expect(registry.selectedProvider("cursor")).toBe("cursor-sdk-default");
    expect(registry.selectedCursorSdk()).toBe("cursor-sdk-default");
    await registry.register(
      createInstance({
        id: "cursor-work",
        provider: "cursor",
        label: "Work",
        homeDir: join(root, "work-sdk"),
      }),
    );
    registry.selectProvider("cursor", "cursor-work");
    registry.close();
    registry = await openRegistry(path);
    expect(registry.selectedCursorSdk()).toBe("cursor-work");
    expect(registry.summary("cursor-work", 2)?.isDefault).toBe(true);
    expect(await readFile(join(editor, "sentinel"), "utf8")).toBe("untouched editor home");
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});
