import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import { InteractionRequest } from "@ace/protocol";
import {
  commands,
  connect,
  fixture,
  latest,
  open,
  pump,
  reset,
  rows,
  until,
} from "./thread-harness.ts";
import { dispatchCommand } from "./commands.ts";
import { lostChild } from "./sheet-fixture.ts";

/*
 * Plan reviews, MCP forms and browser requests answered on the phone, over the real SDK and the
 * fake daemon: each card's row, the canonical resolution on the wire, and choices that don't fit
 * the request refused before anything is saved. No provider CLI runs.
 */

afterEach(reset);

function asking(id: string, raw: Record<string, unknown>) {
  const request = InteractionRequest.parse(raw);
  const fake = fixture();
  fake.createThread({ id, workspaceId: "ace", title: id, provider: "claude" });
  fake.apply(id, [
    facts.rootAgent("claude"),
    facts.turn("root"),
    { type: "interaction.opened", agent: "root", interaction: "ask", blocking: true, request },
  ]);
  return fake;
}
const card = (kind: string) =>
  until(
    () => rows("thread.interaction").find((row) => row.kind === kind && row.state === "pending"),
    `the ${kind} card`,
  );

test("a plan is approved as is, or sent back only with what should change", async () => {
  const thread = open(
    connect(
      asking("plan", {
        kind: "plan_review",
        title: "Ship kill-all",
        markdown: "1. Record start times\n2. Filter by owner",
        todos: [{ content: "Record start times", status: "pending" }],
      }),
    ),
    "plan",
  );
  const row = await card("plan_review");
  expect(row.plan).toMatchObject({
    title: "Ship kill-all",
    markdown: "1. Record start times\n2. Filter by owner",
    todos: [{ text: "Record start times", status: "pending" }],
    // The strip's one line: the plan's own todo list counts its steps.
    line: "Plan ready · Ship kill-all · 1 step",
  });
  const interactionId = String(row.id);
  thread.handle({
    type: "resolve",
    interactionId,
    answer: { kind: "plan", decision: "reject", feedback: "  " },
    requestId: "empty",
  });
  await until(() => latest("admission", "empty"), "a refusal");
  expect(latest("admission", "empty")?.ok).toBe(false);
  thread.handle({
    type: "resolve",
    interactionId,
    answer: { kind: "plan", decision: "reject", feedback: " Keep PIDs out of logs " },
    requestId: "revise",
  });
  await until(
    () => rows("thread.interaction").find((r) => r.id === interactionId && r.state === "resolved"),
    "the canonical close",
  );
  expect(commands("interaction.resolve").map((payload) => payload.resolution)).toEqual([
    { kind: "plan_review", decision: "reject", feedback: "Keep PIDs out of logs" },
  ]);
});

test("approving a plan sends approve", async () => {
  const thread = open(
    connect(asking("plan-ok", { kind: "plan_review", markdown: "Do it" })),
    "plan-ok",
  );
  const row = await card("plan_review");
  thread.handle({
    type: "resolve",
    interactionId: String(row.id),
    answer: { kind: "plan", decision: "approve" },
    requestId: "ok",
  });
  await until(() => commands("interaction.resolve").length === 1, "the approval");
  expect(commands("interaction.resolve")[0]?.resolution).toEqual({
    kind: "plan_review",
    decision: "approve",
  });
});

test("a form is accepted only with typed values that pass its schema", async () => {
  const thread = open(
    connect(
      asking("form", {
        kind: "elicitation",
        server: "deploy",
        message: "Where should it deploy?",
        mode: "form",
        schema: {
          type: "object",
          properties: {
            region: {
              type: "string",
              title: "Region",
              enum: ["eu", "us"],
              enumNames: ["EU", "US"],
            },
            replicas: { type: "integer", title: "Replicas", minimum: 1, maximum: 5 },
            dryRun: { type: "boolean", title: "Dry run" },
          },
          required: ["region", "replicas"],
        },
      }),
    ),
    "form",
  );
  const row = await card("elicitation");
  const form = row.form as {
    unsupported: boolean;
    fields: {
      key: string;
      type: string;
      required: boolean;
      choices: { value: string; label: string }[];
    }[];
  };
  expect(form.unsupported).toBe(false);
  expect(form.fields.map((field) => [field.key, field.type, field.required])).toEqual([
    ["region", "string", true],
    ["replicas", "integer", true],
    ["dryRun", "boolean", false],
  ]);
  expect(form.fields[0]?.choices).toEqual([
    { value: "eu", label: "EU" },
    { value: "us", label: "US" },
  ]);
  const interactionId = String(row.id);
  thread.handle({
    type: "resolve",
    interactionId,
    answer: { kind: "form", action: "accept", values: { region: "eu", replicas: "9" } },
    requestId: "bad",
  });
  await until(() => latest("admission", "bad"), "a refusal");
  expect(latest("admission", "bad")?.ok).toBe(false);
  thread.handle({
    type: "resolve",
    interactionId,
    answer: {
      kind: "form",
      action: "accept",
      values: { region: "us", replicas: "3", dryRun: "true" },
    },
    requestId: "good",
  });
  await until(() => commands("interaction.resolve").length === 1, "the submission");
  expect(commands("interaction.resolve")[0]?.resolution).toEqual({
    kind: "elicitation",
    action: "accept",
    content: { region: "us", replicas: 3, dryRun: true },
  });
});

test("a form ace can't draw can still be declined, never accepted", async () => {
  const thread = open(
    connect(
      asking("odd", {
        kind: "elicitation",
        server: "deploy",
        message: "Nested",
        schema: { type: "object", properties: { deep: { type: "object" } } },
      }),
    ),
    "odd",
  );
  const row = await card("elicitation");
  expect((row.form as { unsupported: boolean }).unsupported).toBe(true);
  thread.handle({
    type: "resolve",
    interactionId: String(row.id),
    answer: { kind: "form", action: "accept", values: {} },
    requestId: "accept",
  });
  await until(() => latest("admission", "accept"), "a refusal");
  expect(latest("admission", "accept")?.ok).toBe(false);
  thread.handle({
    type: "resolve",
    interactionId: String(row.id),
    answer: { kind: "form", action: "decline" },
    requestId: "decline",
  });
  await until(() => commands("interaction.resolve").length === 1, "the decline");
  expect(commands("interaction.resolve")[0]?.resolution).toEqual({
    kind: "elicitation",
    action: "decline",
  });
});

test("a browser request says Done for the tab the agent waits on", async () => {
  const thread = open(
    connect(
      asking("help", {
        kind: "browser_help",
        tabId: "tab-1",
        reason: "login",
        message: "Sign in with the team account",
        url: "https://github.com/login",
      }),
    ),
    "help",
  );
  const row = await card("browser_help");
  expect(row.help).toEqual({
    title: "Sign in to github.com in the Browser",
    detail: "Sign in with the team account",
  });
  thread.handle({
    type: "resolve",
    interactionId: String(row.id),
    answer: { kind: "plan", decision: "approve" },
    requestId: "wrong",
  });
  await until(() => latest("admission", "wrong"), "a refusal");
  expect(latest("admission", "wrong")?.ok).toBe(false);
  thread.handle({
    type: "resolve",
    interactionId: String(row.id),
    answer: { kind: "help", outcome: "done" },
    requestId: "done",
  });
  await until(() => commands("interaction.resolve").length === 1, "done");
  expect(commands("interaction.resolve")[0]?.resolution).toEqual({
    kind: "browser_help",
    outcome: "done",
  });
});

test("each request carries its strip line: who asks, by provider mark, and the one line under it", async () => {
  open(
    connect(
      asking("strip-run", {
        kind: "approval",
        title: "Run bun run test",
        target: { tool: "Bash", command: "bun run test", access: "execute" },
        options: [
          { id: "allow", label: "Allow", kind: "allow_once" },
          { id: "deny", label: "Deny", kind: "deny" },
        ],
      }),
    ),
    "strip-run",
  );
  const approval = await card("approval");
  expect(approval.strip).toEqual({
    lead: { provider: "claude" },
    sentence: "Claude Code wants to run a command",
    payload: "bun run test",
    detail: "",
  });
  reset();
  open(
    connect(
      asking("strip-plan", {
        kind: "plan_review",
        title: "Kill-all filters",
        markdown: "1. Record start times\n2. Add filters\n3. Skip reused PIDs",
      }),
    ),
    "strip-plan",
  );
  const plan = await card("plan_review");
  expect(plan.strip).toMatchObject({
    lead: { provider: "claude" },
    sentence: "Plan ready · Kill-all filters · 3 steps",
  });
});

test("the parent's strip shows the request about a lost child, and its one answer stops tracking it", async () => {
  const fake = fixture();
  fake.createThread({ id: "parent", workspaceId: "ace", title: "Parent", provider: "claude" });
  fake.apply("parent", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    ...lostChild("child-a").facts,
  ]);
  const client = connect(fake);
  open(client, "parent");
  const row = await card("approval");
  // No agent asks it: the strip leads with the daemon's sentence, and what else to do under it.
  expect(row.strip).toMatchObject({
    sentence: "Lost: Studio is no longer paired; its work there may still be running.",
    detail: "Pair Studio again to keep tracking reviewer, or stop tracking it here.",
  });
  // Its one option is the strip's one verb, worded as the row's action.
  const options = row.options as { id: string }[];
  const decisions = row.decisions as { option: number; label: string }[];
  expect(decisions.map((decision) => [decision.label, options[decision.option]?.id])).toEqual([
    ["Stop tracking", "stop-tracking"],
  ]);
  await dispatchCommand(
    client,
    {
      type: "interaction.resolve",
      interactionId: String(row.id),
      resolution: { kind: "approval", optionId: "stop-tracking" },
    },
    "strip",
    pump,
  );
  await until(
    () => rows("thread.interaction").find((r) => r.id === row.id && r.state === "resolved"),
    "the request closes",
  );
  expect(commands("interaction.resolve")[0]?.resolution).toEqual({
    kind: "approval",
    optionId: "stop-tracking",
  });
});
