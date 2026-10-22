import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { coreToolsHeader, staticToolsHeader } from "@ace/mcp-server";
import type { ThreadId } from "@ace/protocol";
import { EvalAgent } from "./evals/agent.ts";
import { evalWorld, type EvalWorld } from "./evals/world.ts";

/**
 * ace's merged agent, thread and automation tools through the real daemon and a real MCP
 * client, with scripted providers. Each test reads results the way a model would.
 */
let world: EvalWorld | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});
const Control = z.object({ ok: z.boolean(), code: z.string().optional(), data: z.unknown() });
const data = (result: { data: unknown }) => Control.parse(result.data).data;
const record = (value: unknown) => z.record(z.string(), z.unknown()).parse(value);
const childIds = (value: unknown) =>
  z.object({ threadIds: z.array(z.string()) }).parse(value).threadIds;

it("agents_status shows a child as unfinished, then returns its result once it settles", async () => {
  world = await evalWorld({ browser: false });
  const { agent } = await world.agent({});
  const task = "Run the linter on login.ts and report problems";
  const started = await agent.call("delegate", {
    tasks: [{ requestId: "lint", task, role: "lint-login", provider: "claude" }],
  });
  const [child] = childIds(data(started));
  if (!child) throw new Error("No child started");
  const before = record(data(await agent.call("agents_status", { threadId: child })));
  expect(before["outcome"]).toBeUndefined();
  expect(before["state"]).not.toBe("result_available");
  await world.answerChildren(new Map([[task, "Lint clean: no problems in login.ts"]]));
  await expect
    .poll(async () => {
      const after = record(data(await agent.call("agents_status", { threadId: child })));
      return z.object({ result: z.string() }).safeParse(after["outcome"]).data?.result;
    })
    .toContain("Lint clean");
  // The snapshot without an id counts it among the settled children.
  const snapshot = z
    .object({ counts: z.object({ done: z.number() }) })
    .parse(data(await agent.call("agents_status", {})));
  expect(snapshot.counts.done).toBe(1);
});

it("a delegated task that names no provider runs on the caller's own provider", async () => {
  world = await evalWorld({ browser: false });
  const { agent, threadId } = await world.agent({});
  const parentProvider = world.store.getThread(threadId)?.provider;
  const started = await agent.call("delegate", {
    tasks: [{ requestId: "same", task: "Summarise README.md", role: "readme-summary" }],
  });
  expect(started.failed, started.text).toBe(false);
  const [child] = childIds(data(started));
  expect(world.store.getThread(child as ThreadId)?.provider).toBe(parentProvider);
});

it("context reports this session's access and project in one read", async () => {
  world = await evalWorld({ browser: false });
  const { agent } = await world.agent({});
  const read = await agent.call("context", { topics: ["status"] });
  const status = z
    .object({
      status: z.object({ access: z.string(), project: z.object({ name: z.string() }) }),
    })
    .parse(read.data).status;
  expect(status).toMatchObject({ access: "full-access", project: { name: "shop" } });
});

it("thread_control renames this thread and thread_read shows the new title", async () => {
  world = await evalWorld({ browser: false });
  const { agent, threadId } = await world.agent({});
  const renamed = await agent.call("thread_control", {
    action: "rename",
    title: "Login page fixes",
  });
  expect(renamed.failed, renamed.text).toBe(false);
  const page = z
    .object({ thread: z.object({ id: z.string(), title: z.string() }) })
    .parse(data(await agent.call("thread_read", {})));
  expect(page.thread).toEqual({ id: threadId, title: "Login page fixes" });
});

it("automations round-trip through list, save and remove; only remove is destructive", async () => {
  world = await evalWorld({ browser: false });
  const { agent } = await world.agent({});
  const hints = new Map(agent.tools.map((tool) => [tool.name, tool.annotations]));
  // Listing reads only, so no provider has reason to ask the person before it.
  expect(hints.get("automations_list")).toMatchObject({
    readOnlyHint: true,
    destructiveHint: false,
  });
  expect(hints.get("automation_put")).toMatchObject({ destructiveHint: false });
  expect(hints.get("automation_remove")).toMatchObject({ destructiveHint: true });
  const ids = async () =>
    z
      .object({ automations: z.array(z.object({ id: z.string() })) })
      .parse(data(await agent.call("automations_list", {})))
      .automations.map((entry) => entry.id);
  expect(await ids()).toEqual([]);
  const saved = await agent.call("automation_put", {
    id: "nightly-lint",
    title: "Nightly lint",
    prompt: "Run the linter and report new problems",
  });
  expect(saved.failed, saved.text).toBe(false);
  expect(await ids()).toEqual(["nightly-lint"]);
  const removed = await agent.call("automation_remove", { id: "nightly-lint" });
  expect(removed.failed, removed.text).toBe(false);
  expect(await ids()).toEqual([]);
});

it("an agent saves a schedule by its rule alone, sees when it runs next, and pauses and resumes it", async () => {
  world = await evalWorld({ browser: false });
  const { agent } = await world.agent({});
  await world.daemon.settings.set("automations.enabled", true, { kind: "global" });
  const saved = await agent.call("automation_put", {
    id: "morning-check",
    title: "Morning check",
    prompt: "Check last night's CI and summarise failures",
    schedule: { kind: "rrule", expression: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0" },
  });
  expect(saved.failed, saved.text).toBe(false);
  const Entry = z.object({
    id: z.string(),
    enabled: z.boolean(),
    nextRunAt: z.number().nullable(),
    trigger: z.object({
      kind: z.literal("schedule"),
      schedule: z.object({ timezone: z.string(), startAt: z.number() }),
    }),
  });
  const entry = z.object({ automation: Entry }).parse(data(saved)).automation;
  // The daemon filled in the zone and the start, and the schedule is armed.
  expect(entry.trigger.schedule.timezone).toBe(
    new Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  expect(entry.trigger.schedule.startAt % 60_000).toBe(0);
  expect(entry.nextRunAt).toBeGreaterThan(0);

  // The run lands in the agent's own thread, so the thread's provider decides; none can be named.
  const named = await agent.call("automation_put", {
    id: "other-provider",
    title: "Other provider",
    prompt: "Anything",
    provider: "codex",
  });
  expect(named.failed).toBe(true);

  const listed = async () =>
    z
      .object({ automations: z.array(Entry) })
      .parse(data(await agent.call("automations_list", {})))
      .automations.find((candidate) => candidate.id === "morning-check");
  expect((await agent.call("automation_pause", { id: "morning-check" })).failed).toBe(false);
  expect(await listed()).toMatchObject({ enabled: false, nextRunAt: null });
  expect(
    (await agent.call("automation_pause", { id: "morning-check", paused: false })).failed,
  ).toBe(false);
  expect((await listed())?.enabled).toBe(true);
  expect((await listed())?.nextRunAt).toBeGreaterThan(0);
});

it("guide returns its family's schemas inline only to a client whose list never grows", async () => {
  world = await evalWorld({ browser: false });
  const { agent: full, connection } = await world.agent({});
  const connect = (header: { name: string; value: string }) =>
    EvalAgent.connect({
      url: connection.url,
      bearer: connection.bearer,
      nativeInstructions: "",
      serverInstructions: true,
      headers: { [header.name]: header.value },
    });
  const core = await connect(coreToolsHeader);
  const fixed = await connect(staticToolsHeader);
  const Guide = z.object({
    tools: z.array(z.string()),
    how: z.string().optional(),
    schemas: z
      .array(z.object({ name: z.string(), inputSchema: z.object({ type: z.literal("object") }) }))
      .optional(),
  });
  const deferred = Guide.parse((await full.call("guide", { topic: "ace-agents" })).data);
  expect(deferred.tools).toContain("agents_status");
  expect(deferred.schemas).toBeUndefined();
  // A core client's reload brings the schemas, so the guide doesn't pay for them twice.
  const reloading = Guide.parse((await core.call("guide", { topic: "ace-agents" })).data);
  expect(reloading.tools).toContain("agents_status");
  expect(reloading.schemas).toBeUndefined();
  expect(reloading.how).toContain("tools_call");
  // Before its client reloads, the agent reaches the new tool through tools_call.
  const early = await core.call("tools_call", { name: "agents_status", arguments: {} });
  expect(early.failed, early.text).toBe(false);
  const inline = Guide.parse((await fixed.call("guide", { topic: "ace-agents" })).data);
  expect(inline.schemas?.map((schema) => schema.name)).toEqual(inline.tools);
  // The inline schema is the one the server validates against: calling with it works.
  const status = await fixed.call("tools_call", { name: "agents_status", arguments: {} });
  expect(status.failed, status.text).toBe(false);
  await core.close();
  await fixed.close();
});
