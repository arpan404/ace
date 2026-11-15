import "./test-host.ts";
import { Interaction } from "@ace/protocol";
import { describe, expect, it } from "vitest";
import { needsResolution } from "./inbox-needs.ts";
import { interactionRow } from "./interaction-rows.ts";
import { alertActions, alertAnswer, alertRequest } from "./notification-request.ts";
import { answerResolution } from "./thread-controls.ts";
import { requestResolution } from "./thread-requests.ts";

/*
 * A request the daemon sends summarized (ADR 0156) is shown on the phone with what it is, says
 * it is too large to review here, and offers only declines: the phone never reads it whole, so
 * it never answers yes to it.
 */

const reader = { item: () => undefined, agent: () => undefined, thread: { provider: "claude" } };

const pending = (request: unknown, summarized: boolean) =>
  Interaction.parse({
    id: "ask",
    threadId: "thread",
    agentId: "root",
    blocking: true,
    request,
    state: "pending",
    createdAt: 1,
    ...(summarized ? { truncated: { chars: 400_000 } } : {}),
  });

const approval = {
  kind: "approval",
  title: "Run the build",
  description: "Builds every package…",
  target: { tool: "Bash", command: "make", access: "execute" },
  options: [
    { id: "allow", label: "Allow once", kind: "allow_once" },
    { id: "always", label: "Always allow", kind: "allow_always" },
    { id: "deny", label: "Deny", kind: "deny" },
  ],
};
const plan = { kind: "plan_review", title: "Ship kill-all", markdown: "1. Record start times…" };
const question = {
  kind: "question",
  questions: [
    {
      id: "scope",
      text: "Include the archived posts?",
      multiSelect: false,
      allowOther: true,
      secret: false,
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
    },
  ],
};
const form = { kind: "elicitation", server: "github", message: "Pick a repository…", mode: "form" };

describe("an approval sent summarized", () => {
  const row = interactionRow(pending(approval, true), reader, "make");

  it("offers Deny alone and says to approve it on a computer", () => {
    expect(row.options.map((option) => option.id)).toEqual(["deny"]);
    expect(row.decisions.map((decision) => decision.verb)).toEqual(["deny"]);
    expect(row.others).toEqual([]);
    expect(row.summarized).toBe(
      "This request is too large to review on the phone. Open it on your computer to approve it.",
    );
    // The strip above the composer says so under its sentence.
    expect(row.strip.detail).toBe(row.summarized);
  });

  it("is denied from the inbox but never allowed", () => {
    const asked = pending(approval, true);
    expect(needsResolution(asked, { kind: "approval", optionId: "deny" })).toEqual({
      kind: "approval",
      optionId: "deny",
    });
    expect(needsResolution(asked, { kind: "approval", optionId: "allow" })).toBeUndefined();
    expect(needsResolution(asked, { kind: "approval", optionId: "always" })).toBeUndefined();
  });
});

it("an approval sent whole offers every option and no note", () => {
  const row = interactionRow(pending(approval, false), reader, "make");
  expect(row.options.map((option) => option.id)).toEqual(["allow", "always", "deny"]);
  expect(row.summarized).toBe("");
  expect(
    needsResolution(pending(approval, false), { kind: "approval", optionId: "allow" }),
  ).toEqual({ kind: "approval", optionId: "allow" });
});

it("a plan sent summarized can be sent back or cancelled, never approved", () => {
  const asked = pending(plan, true);
  expect(interactionRow(asked, reader).summarized).toBe(
    "This request is too large to review on the phone. Open it on your computer to approve it.",
  );
  expect(requestResolution(asked, { kind: "plan", decision: "approve" })).toBeUndefined();
  expect(requestResolution(asked, { kind: "plan", decision: "cancel" })).toEqual({
    kind: "plan_review",
    decision: "cancel",
  });
  expect(
    requestResolution(asked, { kind: "plan", decision: "reject", feedback: "Smaller steps" }),
  ).toEqual({ kind: "plan_review", decision: "reject", feedback: "Smaller steps" });
  expect(requestResolution(pending(plan, false), { kind: "plan", decision: "approve" })).toEqual({
    kind: "plan_review",
    decision: "approve",
  });
});

it("a question sent summarized can only be skipped here", () => {
  const asked = pending(question, true);
  const row = interactionRow(asked, reader);
  expect(row.unanswerable).toBe(true);
  expect(row.summarized).toBe(
    "This request is too large to review on the phone. Open it on your computer to answer it.",
  );
  expect(answerResolution(asked, { scope: ["yes"] }, false)).toBeUndefined();
  expect(answerResolution(asked, {}, true)).toEqual({
    kind: "question",
    answers: {},
    dismissed: true,
  });
  expect(answerResolution(pending(question, false), { scope: ["yes"] }, false)).toEqual({
    kind: "question",
    answers: { scope: ["yes"] },
  });
});

it("a form sent summarized can be declined or cancelled, never filled in", () => {
  const asked = pending(form, true);
  const row = interactionRow(asked, reader);
  expect(row.form).toMatchObject({ unsupported: true, fields: [] });
  expect(row.summarized).toBe(
    "This request is too large to review on the phone. Open it on your computer to answer it.",
  );
  expect(requestResolution(asked, { kind: "form", action: "accept", values: {} })).toBeUndefined();
  expect(requestResolution(asked, { kind: "form", action: "decline" })).toEqual({
    kind: "elicitation",
    action: "decline",
  });
});

describe("a notification for a summarized request", () => {
  const actions = [
    { action: "approve" as const, optionId: "allow" },
    { action: "deny" as const, optionId: "deny" },
  ];

  it("keeps Deny and drops Approve", () => {
    expect(alertActions(actions, pending(approval, true))).toEqual([
      { action: "deny", optionId: "deny" },
    ]);
    expect(alertActions(actions, pending(approval, false))).toEqual(actions);
  });

  it("offers no answers to a question, and a tapped one answers nothing", () => {
    const asked = pending(question, true);
    expect(alertRequest(asked, reader)).toMatchObject({ choices: [], reply: false });
    expect(alertAnswer(asked, "scope", "yes")).toBeUndefined();
    expect(alertRequest(pending(question, false), reader)).toMatchObject({
      choices: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
      reply: true,
    });
  });
});
