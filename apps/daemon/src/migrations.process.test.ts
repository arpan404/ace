import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { Store } from "@ace/daemon";

test.each([1, 9, 12])(
  "a daemon database at older schema %s is refused untouched instead of upgraded",
  async (version) => {
    const home = await mkdtemp(join(tmpdir(), "ace-older-schema-"));
    const path = join(home, "events.sqlite");
    try {
      const store = new Store(path);
      const workspaceId = store.createWorkspace(home, "Existing project");
      store.close();
      const db = new DatabaseSync(path);
      db.prepare("UPDATE schema_version SET version=? WHERE id=1").run(version);
      db.close();
      expect(() => new Store(path)).toThrow(
        expect.objectContaining({
          code: "incompatible-data",
          path,
          message: expect.stringContaining(`schema ${version}, and this build reads schema`),
        }),
      );
      const after = new DatabaseSync(path, { readOnly: true });
      try {
        expect(after.prepare("SELECT version FROM schema_version").get()?.version).toBe(version);
        expect(after.prepare("SELECT id FROM workspaces").get()?.id).toBe(workspaceId);
      } finally {
        after.close();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
