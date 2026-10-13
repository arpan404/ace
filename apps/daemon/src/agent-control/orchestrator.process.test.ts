import { expect, test } from "vitest";
import { AgentControlOperation, AgentCatalogPage } from "@ace/protocol";
import { createAgentControlPort } from "@ace/daemon";
import { setup, wakes } from "./test-support.ts";
import { question } from "../engine/test-support.ts";

test("catalog reads retain composer identities without exposing account homes or raw provider data", async () => {
  const h = setup();
  const caller = await h.parent();
  const port = createAgentControlPort(h.store, h.service);
  const reply = await port.execute(
    caller,
    AgentControlOperation.parse({ op: "agents.catalog", provider: "claude" }),
    new AbortController().signal,
  );
  expect(reply.ok).toBe(true);
  const page = AgentCatalogPage.parse(reply.data);
  expect(page.models.map((model) => model.id)).toEqual(
    h.catalog.list({ provider: "claude", limit: 10 }).models.map((model) => model.id),
  );
  expect(page.instances[0]).toMatchObject({ installed: true, auth: "logged_in" });
  expect(JSON.stringify(reply)).not.toContain(h.home);
  expect(JSON.stringify(reply)).not.toContain('"raw"');
  expect(h.inputs.size).toBe(1);
});

test("a child result stays unavailable while a grandchild waits for a person", async () => {
  const h = setup();
  const caller = await h.parent();
  const child = h.delegate(caller, "child");
  await h.engine.flush();
  const grandchild = h.delegate(h.caller(child.childId), "grandchild");
  await h.engine.flush();
  // The grandchild stays blocked on the approval; a turn end would cancel it (core cleanup).
  await h.emit(grandchild.childId, question);
  await h.complete(child.childId, "foreground answer");
  const port = createAgentControlPort(h.store, h.service);
  const signal = new AbortController().signal;
  expect(
    await port.execute(
      caller,
      AgentControlOperation.parse({ op: "agent.status", threadId: child.childId }),
      signal,
    ),
  ).toMatchObject({ ok: true, data: { state: "waiting_on_human" } });
  expect(
    await port.execute(
      caller,
      AgentControlOperation.parse({ op: "agent.result", threadId: child.childId }),
      signal,
    ),
  ).toMatchObject({ ok: false, code: "not_ready" });
  h.clock.advance(1100);
  await h.engine.flush();
  expect(wakes(h.events, caller.threadId)).toHaveLength(0);
});

test("a bounded wait expires without cancelling work or consuming its later parent wake", async () => {
  const h = setup();
  const caller = await h.parent();
  const child = h.delegate(caller, "bounded");
  await h.engine.flush();
  const waiting = h.service.waitBounded(caller, child.childId, new AbortController().signal, 25);
  h.clock.advance(1025);
  expect(await waiting).toBeUndefined();
  expect(h.store.getThread(child.childId)?.status.state).toBe("working");
  await h.complete(child.childId, "after deadline");
  const port = createAgentControlPort(h.store, h.service);
  expect(
    await port.execute(
      caller,
      AgentControlOperation.parse({ op: "agent.result", threadId: child.childId }),
      new AbortController().signal,
    ),
  ).toMatchObject({
    ok: true,
    data: { state: "result_available", outcome: { result: "after deadline" } },
  });
  h.clock.advance(1100);
  await h.engine.flush();
  expect(wakes(h.events, caller.threadId)).toHaveLength(1);
});

test("follow-up uses the same child and hides the previous result until the next turn settles", async () => {
  const h = setup();
  const caller = await h.parent();
  const child = h.delegate(caller, "reuse");
  await h.engine.flush();
  await h.complete(child.childId, "first");
  const port = createAgentControlPort(h.store, h.service);
  const signal = new AbortController().signal;
  expect(
    await port.execute(
      caller,
      AgentControlOperation.parse({
        op: "agent.message",
        threadId: child.childId,
        requestId: "follow-up",
        text: "continue",
      }),
      signal,
    ),
  ).toMatchObject({ ok: true });
  await h.engine.flush();
  expect(
    await port.execute(
      caller,
      AgentControlOperation.parse({ op: "agent.result", threadId: child.childId }),
      signal,
    ),
  ).toMatchObject({ ok: false, code: "not_ready" });
  await h.complete(child.childId, "second");
  expect(
    await port.execute(
      caller,
      AgentControlOperation.parse({ op: "agent.result", threadId: child.childId }),
      signal,
    ),
  ).toMatchObject({ ok: true, data: { outcome: { result: "second" } } });
  expect(h.store.listThreads()).toHaveLength(2);
});

test("cancel denies sibling control and stops every owned descendant", async () => {
  const h = setup();
  const caller = await h.parent();
  const child = h.delegate(caller, "cancel");
  const sibling = h.delegate(caller, "sibling");
  await h.engine.flush();
  const grandchild = h.delegate(h.caller(child.childId), "nested");
  await h.engine.flush();
  const port = createAgentControlPort(h.store, h.service);
  const operation = AgentControlOperation.parse({
    op: "agent.cancel",
    threadId: child.childId,
    requestId: "stop",
  });
  expect(
    await port.execute(h.caller(sibling.childId), operation, new AbortController().signal),
  ).toMatchObject({ ok: false, code: "forbidden" });
  expect(await port.execute(caller, operation, new AbortController().signal)).toMatchObject({
    ok: true,
  });
  await h.engine.flush();
  expect(
    await h.service.wait(caller, grandchild.childId, new AbortController().signal),
  ).toMatchObject({ outcome: "cancelled" });
  expect(
    await port.execute(
      caller,
      AgentControlOperation.parse({ op: "agent.status", threadId: child.childId }),
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: true, data: { state: "cancelled" } });
  expect(h.store.getThread(sibling.childId)?.status.state).toBe("working");
});
