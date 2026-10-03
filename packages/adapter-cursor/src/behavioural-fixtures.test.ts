import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  readFixture,
  replayFixture,
  readExpectations,
  assertExpectations,
} from "@ace/adapter-testkit";
import { createCursorAdapter } from "./index.ts";

const cases = [
  "text-thinking-read",
  "edit-shell-results",
  "plan-question",
  "foreground-child",
  "background-child",
  "nested-task",
  "background-shell",
  "interrupt-work",
  "steering-restart",
  "checkpoint-resume",
  "portable-fork",
  "usage",
];
const pathFor = (name: string) =>
  fileURLToPath(
    new URL(`../../../fixtures/cursor-sdk/1.0.35/composer-2.5/${name}.jsonl`, import.meta.url),
  );
const replay = async (name: string) => {
  const fixture = await readFixture(pathFor(name));
  const threads = Object.entries(fixture.threads ?? {});
  return {
    fixture,
    results: threads.map(([threadId, frames]) =>
      replayFixture({
        fixture: { ...fixture, frames },
        threadId,
        createTranslator: createCursorAdapter().createTranslator,
        coreConfig: { provider: "cursor", silenceMs: 90000 },
      }),
    ),
  };
};

it.each(cases)(
  "the recorded %s stays working before its terminal evidence and retains its observed tree",
  async (name) => {
    const { fixture, results } = await replay(name);
    expect(results.length).toBe(name === "portable-fork" ? 2 : 1);
    for (const [index, result] of results.entries()) {
      const suffix =
        name === "portable-fork"
          ? index === 0
            ? ".source.expect.json"
            : ".fork.expect.json"
          : ".expect.json";
      assertExpectations(result, await readExpectations(pathFor(name).replace(".jsonl", suffix)));
    }
    expect(fixture.header).toMatchObject({
      recordingPolicy: "full-access",
      sandbox: false,
      autoReview: false,
    });
  },
);

it("a recorded task with identity already present retains its live child content at summary fidelity", async () => {
  const { results } = await replay("foreground-child");
  const result = results[0];
  if (!result) throw new Error("Missing foreground evidence");
  const child = Object.values(result.final.view.agents).find(
    (agent) => agent.origin === "provider_subagent",
  );
  expect(child).toMatchObject({ fidelity: "summary", status: { state: "idle" } });
  const messages = Object.values(result.final.view.items).filter(
    (item) => item.agentId === child?.id && item.type === "message",
  );
  expect(messages).toHaveLength(1);
  expect(JSON.stringify(messages)).toContain("calc-demo");
  expect(
    result.timeline.some(
      (point) =>
        point.agents.root?.state === "blocked" &&
        Object.values(point.agents).filter((agent) => agent.state === "working").length === 1 &&
        point.thread.state === "working",
    ),
  ).toBe(true);
});

it("recorded requested-background tasks remain foreground when native results say so", async () => {
  const { results } = await replay("background-child");
  const result = results[0];
  if (!result) throw new Error("Missing task evidence");
  const children = Object.values(result.final.view.agents).filter(
    (agent) => agent.origin === "provider_subagent",
  );
  expect(children).toHaveLength(2);
  expect(
    children.every(
      (child) => !child.background && child.fidelity === "summary" && child.status.state === "idle",
    ),
  ).toBe(true);
  expect(result.final.thread.state).toBe("done");
});

it("the recorded exit-three shell stays failed beside the successful echo and edit", async () => {
  const { results } = await replay("edit-shell-results");
  const tools = Object.values(results[0]?.final.view.items ?? {}).flatMap((item) =>
    item.type === "tool_call" ? [item.call] : [],
  );
  const shells = tools.filter((tool) => tool.kind === "shell");
  expect(shells).toHaveLength(2);
  expect(
    shells.find((tool) => tool.detail?.kind === "shell" && tool.detail.exitCode === 3),
  ).toMatchObject({ status: "failed" });
  expect(
    shells.find((tool) => tool.detail?.kind === "shell" && tool.detail.exitCode === 0),
  ).toMatchObject({ status: "succeeded", detail: { output: { tail: "hello from echo\n" } } });
  expect(tools.find((tool) => tool.kind === "file.edit")?.status).toBe("succeeded");
});

it("recorded todos and plan markdown remain visible without inventing a question interaction", async () => {
  const { results } = await replay("plan-question");
  const result = results[0];
  const tools = Object.values(result?.final.view.items ?? {}).flatMap((item) =>
    item.type === "tool_call" ? [item.call] : [],
  );
  expect(tools.find((tool) => tool.kind === "todo")?.detail).toMatchObject({
    kind: "todo",
    todos: [
      { status: "in_progress" },
      { status: "pending" },
      { status: "pending" },
      { status: "pending" },
      { status: "pending" },
    ],
  });
  expect(JSON.stringify(tools.find((tool) => tool.kind === "plan")?.detail)).toContain(
    "Math validation plan",
  );
  expect(Object.values(result?.final.view.interactions ?? {})).toHaveLength(0);
});

it("recorded cancellation settles an interrupted root without fabricated usage or a child", async () => {
  const { results } = await replay("interrupt-work");
  const result = results[0];
  expect(Object.values(result?.final.view.agents ?? {})).toMatchObject([
    { status: { state: "interrupted" } },
  ]);
  expect(Object.values(result?.final.view.usage ?? {})).toHaveLength(0);
  expect(Object.values(result?.final.view.runs ?? {})).toHaveLength(1);
});

it("recorded steering keeps one logical turn across two native segments and finishes the replacement", async () => {
  const { fixture, results } = await replay("steering-restart");
  const result = results[0];
  expect(Object.values(result?.final.view.runs ?? {})).toHaveLength(1);
  const analysis = z
    .object({ threads: z.array(z.object({ nativeRunIds: z.array(z.string()) })) })
    .parse(fixture.metadata?.find((value) => value.type === "sdk-scenario-analysis")?.observations);
  expect(analysis.threads[0]?.nativeRunIds).toHaveLength(2);
  expect(result?.timeline.find((point) => point.t === 6532)?.thread.state).toBe("working");
  expect(JSON.stringify(Object.values(result?.final.view.items ?? {}))).toContain("calc-demo");
});

it("the failed checkpoint attempt retains the completed source without claiming a resumed turn", async () => {
  const { fixture, results } = await replay("checkpoint-resume");
  expect(Object.values(results[0]?.final.view.runs ?? {})).toHaveLength(1);
  expect(
    fixture.metadata?.find((value) => value.type === "sdk-scenario-analysis")?.observations,
  ).toMatchObject({ outcome: "incomplete", resumed: false, forked: false });
  expect(results[0]?.final.thread.state).toBe("done");
});

it("recorded portable handoff preserves the source and gives the fork its own native identity and bounded context", async () => {
  const { fixture, results } = await replay("portable-fork");
  const native = results.map(
    (result) => Object.values(result.final.view.agents)[0]?.native?.nativeId,
  );
  expect(native).toHaveLength(2);
  expect(native[0]).toBeTruthy();
  expect(native[1]).toBeTruthy();
  expect(native[0]).not.toBe(native[1]);
  expect(results.every((result) => result.final.thread.state === "done")).toBe(true);
  expect(JSON.stringify(Object.values(results[1]?.final.view.items ?? {}))).toContain(
    "sourceThreadId",
  );
  expect(
    fixture.metadata?.find((value) => value.type === "sdk-scenario-analysis")?.observations,
  ).toMatchObject({ outcome: "observed", resumed: false, forked: true });
});

it("recorded usage counts one cumulative turn without counting matching message/result totals again", async () => {
  const { results } = await replay("usage");
  expect(Object.values(results[0]?.final.view.usage ?? {})).toMatchObject([
    {
      inputTokens: 15912,
      outputTokens: 172,
      cachedInputTokens: 6848,
      counterMode: "cumulative",
      billingMode: "unknown",
    },
  ]);
  expect(Object.values(results[0]?.final.view.usage ?? {})).toHaveLength(1);
});
