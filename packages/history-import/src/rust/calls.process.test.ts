import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ThreadId, WorkspaceId } from "@ace/protocol";
import { environment, memorySink } from "../test-support.ts";
import { callsHome, withoutRoot } from "./calls-fixture.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0)) await run();
});

test("tool calls pair with their results as the TypeScript reader paired them", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const instances = await callsHome(env.root);
  const service = await env.start(instances);
  await service.scan();
  const [source] = (await service.list({ type: "history.list", cwd: "/workspace/project" }))
    .sessions;
  if (!source) throw new Error("no session");
  const sink = memorySink();
  const result = await service.importSession(
    {
      sourceId: source.id,
      threadId: ThreadId.parse("calls"),
      workspaceId: WorkspaceId.parse("w"),
      agentId: "agent",
      at: 1,
    },
    sink,
  );
  // What the deleted TypeScript reader made of the same fixture (calls-expected.json): a call
  // with no id stays pending and takes no other call's result, and a result in its call's own
  // record links to it.
  const expected: unknown = JSON.parse(
    await readFile(new URL("./calls-expected.json", import.meta.url), "utf8"),
  );
  expect(withoutRoot({ result, items: sink.items }, env.root, { [source.id]: "<source>" })).toEqual(
    expected,
  );
  await rm(join(env.root, "calls"), { recursive: true, force: true });
});
