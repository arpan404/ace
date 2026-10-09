import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { copyHome } from "./copy-home.ts";

test("backs up committed WAL rows and copies settings without touching forbidden state", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-smoke-copy-"));
  const source = join(root, "source"),
    scratch = join(root, "scratch");
  await mkdir(source);
  await mkdir(scratch);
  const database = new DatabaseSync(join(source, "events.sqlite"));
  try {
    database.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE messages(text TEXT); INSERT INTO messages VALUES('committed while daemon runs')",
    );
    await writeFile(
      join(source, "settings.json"),
      JSON.stringify({
        version: 2,
        settings: { "automations.enabled": true, "host.displayName": "Smoke owner" },
      }),
    );
    for (const name of ["daemon-token", "daemon-lock", "daemon-endpoint", "auth.json"])
      await symlink("/path-that-must-never-be-opened", join(source, name));
    await mkdir(join(source, "instances"));
    await symlink("/path-that-must-never-be-opened", join(source, "instances", "auth.json"));
    expect(await copyHome(source, scratch)).toEqual(["settings.json", "events.sqlite"]);
    const copy = new DatabaseSync(join(scratch, "events.sqlite"), { readOnly: true });
    try {
      expect(copy.prepare("SELECT text FROM messages").get()?.text).toBe(
        "committed while daemon runs",
      );
    } finally {
      copy.close();
    }
    expect(
      JSON.parse(await readFile(join(scratch, "settings.json"), "utf8")).settings,
    ).toMatchObject({ "automations.enabled": false, "host.displayName": "Smoke owner" });
    expect(
      JSON.parse(await readFile(join(source, "settings.json"), "utf8")).settings[
        "automations.enabled"
      ],
    ).toBe(true);
    expect(database.prepare("SELECT text FROM messages").get()?.text).toBe(
      "committed while daemon runs",
    );
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("refuses a safe-state symlink before reading its destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-smoke-copy-"));
  try {
    const source = join(root, "source"),
      scratch = join(root, "scratch");
    await mkdir(source);
    await mkdir(scratch);
    await symlink("/never-read-auth.json", join(source, "settings.json"));
    await expect(copyHome(source, scratch)).rejects.toThrow("regular file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "darwin")(
  "backs up a closed WAL store without creating sidecars in the protected source",
  async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { realpath, readdir } = await import("node:fs/promises");
    const root = await realpath(await mkdtemp(join(tmpdir(), "ace-smoke-closed-wal-")));
    const source = join(root, "source"),
      scratch = join(root, "scratch");
    try {
      await mkdir(source);
      await mkdir(scratch);
      const database = new DatabaseSync(join(source, "events.sqlite"));
      database.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE history(text TEXT); INSERT INTO history VALUES('checkpointed conversation')",
      );
      database.close();
      const initial = await readdir(source);
      await promisify(execFile)("/usr/bin/sandbox-exec", [
        "-p",
        `(version 1)(allow default)(deny file-write*)(allow file-write* (subpath ${JSON.stringify(scratch)}) (literal "/dev/null"))`,
        process.execPath,
        new URL("./copy-child.ts", import.meta.url).pathname,
        source,
        scratch,
      ]);
      const copy = new DatabaseSync(join(scratch, "events.sqlite"), { readOnly: true });
      try {
        expect(copy.prepare("SELECT text FROM history").get()?.text).toBe(
          "checkpointed conversation",
        );
      } finally {
        copy.close();
      }
      expect(await readdir(source)).toEqual(initial);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
