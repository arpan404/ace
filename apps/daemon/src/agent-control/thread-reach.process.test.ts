import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { expect, test } from "vitest";
import { AgentControlOperation, SearchResults, ThreadId, type McpAttribution } from "@ace/protocol";
import { createAgentControlPort } from "@ace/daemon";
import { start } from "../engine/test-support.ts";
import { setup } from "./test-support.ts";

const signal = () => new AbortController().signal;

function harness() {
  const h = setup();
  const port = createAgentControlPort(h.store, h.service);
  const run = (caller: McpAttribution, operation: Record<string, unknown>) =>
    port.execute(caller, AgentControlOperation.parse(operation), signal());
  const message = (caller: McpAttribution, threadId: ThreadId, requestId: string, text: string) =>
    run(caller, { op: "thread.message", threadId, requestId, text });
  return { h, run, message };
}

test("an agent with full access messages and settles a thread the person started", async () => {
  const { h, run, message } = harness();
  const agent = await h.parent("full-access");
  const person = await h.parent("ask");
  await h.complete(person.threadId, "Finished");
  expect(await message(agent, person.threadId, "nudge", "Also update the docs")).toMatchObject({
    ok: true,
  });
  await h.engine.flush();
  expect(h.inputs.get(person.threadId)?.at(-1)).toBe("Also update the docs");
  await h.complete(person.threadId, "Docs updated");
  expect(await run(agent, { op: "thread.settle", threadId: person.threadId })).toMatchObject({
    ok: true,
  });
  expect(h.store.getThread(person.threadId)?.settledAt).toEqual(expect.any(Number));
});

test("without full access the person's threads stay read-only to an agent", async () => {
  const { h, run, message } = harness();
  const agent = await h.parent("auto-review");
  const person = await h.parent("ask");
  await h.complete(person.threadId, "Finished");
  expect(await message(agent, person.threadId, "nudge", "Change course")).toMatchObject({
    ok: false,
    code: "forbidden",
  });
  expect(await run(agent, { op: "thread.settle", threadId: person.threadId })).toMatchObject({
    ok: false,
    code: "forbidden",
  });
  expect(await run(agent, { op: "thread.read", threadId: person.threadId })).toMatchObject({
    ok: true,
  });
});

test("a delegated child with full access never reaches the person's threads", async () => {
  const { h, message } = harness();
  const parent = await h.parent("full-access");
  const person = await h.parent("ask");
  await h.complete(person.threadId, "Finished");
  const child = h.delegate(parent, "worker");
  await h.engine.flush();
  expect(h.store.getThread(child.childId)?.permission?.effective).toBe("full-access");
  expect(
    await message(h.caller(child.childId), person.threadId, "stray", "Do this instead"),
  ).toMatchObject({ ok: false, code: "forbidden" });
});

test("another project's threads are readable with full access and refused without it", async () => {
  const { h, run } = harness();
  const path = join(h.home, "nivra-rij");
  await mkdir(path);
  const other = h.store.createWorkspace(path, "nivra-rij");
  h.service.command("landing", {
    type: "thread.prepare",
    workspaceId: other,
    provider: "codex",
    threadId: ThreadId.parse("landing-page"),
    title: "Landing page redesign",
  });
  h.store.search.flush();
  const full = await h.parent("full-access");
  const limited = await h.parent("auto-review");
  const find = (caller: McpAttribution) =>
    run(caller, { op: "threads.list", query: "landing", project: "nivra-rij" });

  const found = await find(full);
  expect(SearchResults.parse(found.data).hits.map((hit) => hit.threadId)).toEqual(["landing-page"]);
  expect(await run(full, { op: "thread.read", threadId: "landing-page" })).toMatchObject({
    ok: true,
  });
  expect(await find(limited)).toMatchObject({
    ok: false,
    code: "forbidden",
    hint: expect.stringContaining("full access"),
  });
  expect(await run(limited, { op: "thread.read", threadId: "landing-page" })).toMatchObject({
    ok: false,
    code: "forbidden",
  });
});

/** An owned conversation mid-turn with three messages waiting behind it. */
async function queued() {
  const tools = harness();
  const { h, message } = tools;
  const agent = await h.parent("full-access");
  const target = await h.parent("ask");
  await h.emit(target.threadId, start);
  for (const text of ["first", "second", "third"])
    expect(await message(agent, target.threadId, text, text)).toMatchObject({ ok: true });
  await h.engine.flush();
  const list = async () => {
    const result = await tools.run(agent, { op: "queue.list", threadId: target.threadId });
    const data = result.data as { entries: { entryId: string; text: string }[] };
    return data.entries;
  };
  const ids = Object.fromEntries((await list()).map((entry) => [entry.text, entry.entryId]));
  return { ...tools, agent, target, list, ids };
}

test("queued messages can be listed, edited, cancelled and reordered before delivery", async () => {
  const { run, agent, target, list, ids } = await queued();
  expect((await list()).map((entry) => entry.text)).toEqual(["first", "second", "third"]);
  const threadId = target.threadId;
  expect(
    await run(agent, {
      op: "queue.edit",
      threadId,
      requestId: "edit",
      entryId: ids["second"],
      text: "second, revised",
    }),
  ).toEqual({ ok: true });
  expect(
    await run(agent, { op: "queue.cancel", threadId, requestId: "cancel", entryId: ids["first"] }),
  ).toEqual({ ok: true });
  expect(
    await run(agent, {
      op: "queue.reorder",
      threadId,
      requestId: "reorder",
      entryIds: [ids["third"], ids["second"]],
    }),
  ).toEqual({ ok: true });
  expect((await list()).map((entry) => entry.text)).toEqual(["third", "second, revised"]);
  expect(
    await run(agent, { op: "queue.cancel", threadId, requestId: "again", entryId: ids["first"] }),
  ).toMatchObject({ ok: false, code: "not_found", hint: expect.stringContaining("thread_read") });
});

test("steering a queued message turns it into the person's steer and it is delivered", async () => {
  const { h, run, agent, target, list, ids } = await queued();
  expect(
    await run(agent, {
      op: "queue.steer",
      threadId: target.threadId,
      requestId: "steer",
      entryId: ids["third"],
    }),
  ).toEqual({ ok: true });
  await h.engine.flush();
  expect(await list()).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: "third", delivery: "steer" })]),
  );
  // This scripted provider cannot steer mid-turn, so the steer lands when the turn ends.
  await h.complete(target.threadId, "turn over");
  await h.engine.flush();
  expect(h.inputs.get(target.threadId)).toContain("third");
  expect(await list()).toEqual([]);
});
