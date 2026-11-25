import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command, ThreadId } from "@ace/protocol";
import { Store } from "../store.ts";
import { EngineRepository } from "./repository.ts";

test("an engine recorded before intents kept their creation time gains it and stamps new ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ace-intent-created-at-"));
  const path = join(dir, "ace.sqlite");
  const legacy = new EngineRepository(
    new Store(path),
    undefined,
    64,
    undefined,
    undefined,
    () => 1_000,
  );
  // The intents table an earlier build wrote: no row records when it was taken.
  legacy.store.atomic((db) => db.exec("ALTER TABLE intents DROP COLUMN created_at"));
  await legacy.store.close();

  const store = new Store(path);
  const repo = new EngineRepository(store, undefined, 64, undefined, undefined, () => 2_000);
  const thread = ThreadId.parse("thread-old");
  store.atomic((db) => {
    db.prepare("INSERT INTO workspaces(id,path,name,created_at) VALUES ('w','/tmp/w','w',1)").run();
    db.prepare(
      `INSERT INTO threads(id,workspace_id,title,provider,status,created_at,updated_at)
       VALUES (?, 'w','t','antigravity','{"state":"new"}',1,1)`,
    ).run(thread);
  });
  repo.add(
    Command.parse({
      id: "command-1",
      deviceId: "device",
      payload: {
        type: "thread.send",
        threadId: thread,
        delivery: "steer",
        input: [{ type: "text", text: "go" }],
      },
    }),
    thread,
  );

  expect(repo.pending.personSteer(thread)?.createdAt).toBe(2_000);
  await store.close();
});
