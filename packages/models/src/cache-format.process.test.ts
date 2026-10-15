import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { openModelStorage } from "./index.ts";

test("a model cache row in an older format is refused with the file, not reinterpreted", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-model-cache-"));
  const path = join(home, "models.sqlite");
  try {
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE model_catalog (instance TEXT PRIMARY KEY, payload TEXT NOT NULL)");
    // Version-one rows listed bare reasoning-effort ids.
    db.prepare("INSERT INTO model_catalog VALUES (?,?)").run(
      "codex",
      JSON.stringify({
        schemaVersion: 1,
        provider: "codex",
        instance: "codex",
        revision: "r1",
        refreshedAt: 1,
        models: [
          {
            id: "gpt",
            provider: "codex",
            instance: "codex",
            displayName: "GPT",
            reasoningEfforts: ["low", "high"],
          },
        ],
      }),
    );
    db.close();
    expect(() => openModelStorage(path)).toThrow(
      expect.objectContaining({
        code: "incompatible-data",
        path,
        message: expect.stringContaining("model cache holds entries in an older format"),
      }),
    );
    const after = new DatabaseSync(path, { readOnly: true });
    try {
      expect(after.prepare("SELECT count(*) AS n FROM model_catalog").get()?.n).toBe(1);
    } finally {
      after.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
