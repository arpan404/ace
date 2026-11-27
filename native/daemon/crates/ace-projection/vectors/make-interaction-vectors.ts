// SPDX-License-Identifier: Apache-2.0

/*
 * Produces `interactions.json`, the fixtures T3's Rust interaction summaries are proved against.
 *
 *   bun native/daemon/crates/ace-projection/vectors/make-interaction-vectors.ts
 *
 * Each case records what `summarizeInteraction` and `sentSummarized`
 * (`packages/projection/src/interaction-summary.ts`) and `wireEvent`/`wireThreadView`
 * (`apps/daemon/src/wire-interactions.ts`) make of an interaction, its event and its thread
 * view. Sizes are pushed past `wholeRequestChars` (64 KiB) and `summaryChars` (60 KiB), so both
 * the summary and the least summary are recorded.
 */

import { join } from "node:path";
import type { Event, Interaction, InteractionRequest, ThreadView } from "@ace/protocol";
import {
  requestChars,
  sentSummarized,
  summarizeInteraction,
} from "../../../../../packages/projection/src/interaction-summary.ts";
import {
  wireEvent,
  wireThreadView,
} from "../../../../../apps/daemon/src/wire-interactions.ts";
import { writeVectors } from "../../../vectors/vectors-io.ts";

const interaction = (request: InteractionRequest, raw: unknown[] = []): Interaction =>
  ({
    id: "i1",
    threadId: "t_tree",
    agentId: "a1",
    blocking: true,
    request,
    state: "pending",
    createdAt: 1,
    raw,
  }) as Interaction;

const approval = (
  overrides: Partial<Extract<InteractionRequest, { kind: "approval" }>> = {},
): InteractionRequest => ({
  kind: "approval",
  title: "Run the command",
  options: [
    { id: "o1", label: "Allow once", kind: "allow_once" },
    { id: "o2", label: "Deny", kind: "deny" },
  ],
  ...overrides,
});

const question = (overrides: Partial<Extract<InteractionRequest, { kind: "question" }>> = {}) =>
  ({
    kind: "question",
    questions: [
      {
        id: "q1",
        header: "Header",
        text: "Which one?",
        options: [
          { id: "a1", label: "First" },
          { id: "a2", label: "Second", description: "The other" },
        ],
        multiSelect: false,
        allowOther: true,
        secret: false,
      },
    ],
    ...overrides,
  }) as InteractionRequest;

const planReview = (
  overrides: Partial<Extract<InteractionRequest, { kind: "plan_review" }>> = {},
): InteractionRequest => ({
  kind: "plan_review",
  title: "Plan",
  summary: "A plan",
  markdown: "# Plan\n\n1. Do it",
  planPath: "/plans/plan.md",
  todos: [
    { id: "t1", content: "Step one", status: "pending" },
    { content: "Step two", status: "completed" },
  ],
  ...overrides,
});

const elicitation = (
  overrides: Partial<Extract<InteractionRequest, { kind: "elicitation" }>> = {},
): InteractionRequest => ({
  kind: "elicitation",
  server: "mcp-server",
  message: "Fill this in",
  url: "https://example.test/form",
  mode: "form",
  nativeId: "native-1",
  title: "Details",
  description: "The details",
  ...overrides,
});

const browserHelp = (
  overrides: Partial<Extract<InteractionRequest, { kind: "browser_help" }>> = {},
): InteractionRequest => ({
  kind: "browser_help",
  tabId: "tab-1",
  reason: "login",
  message: "Sign in here",
  url: "https://example.test",
  title: "Sign in",
  ...overrides,
});

const requests: { name: string; request: InteractionRequest }[] = [
  { name: "a small approval goes whole", request: approval() },
  {
    name: "a small approval with a target keeps the target's input",
    request: approval({
      description: "About to run",
      target: {
        tool: "shell",
        description: "git status",
        command: "git status",
        cwd: "/repo",
        paths: ["/repo/a.ts", "/repo/b.ts"],
        access: "execute",
        input: { blob: "x".repeat(1000) },
      },
      defaultToNo: true,
      suppressAlwaysAllowRule: false,
      mcpServer: { name: "server", source: "the user" },
    }),
  },
  {
    name: "an elicitation schema over 64 KiB is left out",
    request: elicitation({ schema: { type: "object", blob: "x".repeat(70_000) } }),
  },
  {
    name: "an approval cuts texts, options and a long target",
    request: approval({
      title: "t".repeat(3000),
      description: "d".repeat(5000),
      target: {
        tool: "shell",
        command: "c".repeat(20_000),
        cwd: "/c".repeat(3000),
        paths: Array.from({ length: 12 }, (_, index) => `/${index}/`.padEnd(2000, "p")),
        access: "execute",
        input: { blob: "x".repeat(70_000) },
      },
      options: Array.from({ length: 40 }, (_, index) => ({
        id: index < 10 ? `allow-${index}` : `deny-${index}`,
        label: "l".repeat(4000),
        kind: index < 10 ? "allow_once" : "deny",
      })),
    }),
  },
  {
    name: "an approval too large for even its summary takes the least request",
    request: approval({
      options: Array.from({ length: 64 }, (_, index) => ({
        id: `deny-${String(index).padStart(4, "0")}-${"i".repeat(1000)}`,
        label: "Stop",
        kind: "deny",
      })),
    }),
  },
  {
    name: "a question cuts texts, answers and drops long ids",
    request: question({
      questions: Array.from({ length: 10 }, (_, index) => ({
        id: index === 9 ? "q".repeat(2000) : `q-${index}`,
        header: "h".repeat(2000),
        text: "t".repeat(3000),
        options: Array.from({ length: 14 }, (_, option) => ({
          id: option === 13 ? "a".repeat(2000) : `a-${index}-${option}`,
          label: "l".repeat(300),
          description: "d".repeat(300),
        })),
        multiSelect: true,
        allowOther: false,
        secret: true,
      })),
      target: {
        tool: "read",
        access: "read",
        input: { blob: "x".repeat(70_000) },
      },
    }),
  },
  {
    name: "a plan review cuts its markdown and todos",
    request: planReview({
      title: "t".repeat(3000),
      summary: "s".repeat(5000),
      markdown: "m".repeat(20_000),
      planPath: "p".repeat(3000),
      todos: Array.from({ length: 40 }, (_, index) => ({
        id: `todo-${index}`,
        content: "c".repeat(600),
        status: "pending",
      })),
    }),
  },
  {
    name: "an elicitation keeps a bounded address and drops a long one",
    request: elicitation({
      server: "s".repeat(2000),
      message: "m".repeat(5000),
      url: `https://example.test/${"u".repeat(9000)}`,
      nativeId: "n".repeat(2000),
      schema: { blob: "x".repeat(70_000) },
    }),
  },
  {
    name: "a browser help summarizes only its target",
    request: browserHelp({
      target: {
        tool: "browser",
        command: "c".repeat(20_000),
        access: "external-effect",
        input: { blob: "x".repeat(70_000) },
      },
      message: "m".repeat(5000),
    }),
  },
  {
    name: "an interaction already summarized is left alone",
    request: elicitation({ schema: { blob: "x".repeat(70_000) } }),
  },
];

const cases = requests.map(({ name, request }, index) => {
  const value = interaction(
    request,
    index === 9 ? [] : [{ type: "projected.message", data: { blob: "r".repeat(200) } }],
  );
  if (index === 9) {
    const chars = requestChars(request);
    (value as { truncated?: { chars: number } }).truncated = { chars };
    (value as { request: InteractionRequest }).request = summarizeInteraction(value).request;
  }
  const sent = summarizeInteraction(value);
  const event = {
    seq: 1,
    id: `e-${index}`,
    at: 1,
    threadId: "t_tree",
    payload: { type: "interaction.opened", interaction: value },
  } as Event;
  const view = {
    kind: "thread",
    seq: 1,
    threadId: "t_tree",
    items: {},
    itemsBefore: null,
    agents: {},
    interactions: { [value.id]: value },
  } as unknown as ThreadView;
  return {
    name,
    interaction: value,
    requestChars: requestChars(value.request),
    sentSummarized: sentSummarized(value),
    sent,
    event,
    wiredEvent: wireEvent(event),
    view,
    wiredView: wireThreadView(view),
  };
});

writeVectors(join(import.meta.dir, "interactions.json"), { cases });
