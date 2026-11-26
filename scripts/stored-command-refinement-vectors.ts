// SPDX-License-Identifier: Apache-2.0

const threadId = "thread";
const workspaceId = "workspace";
const repository = { forge: "github", host: "github.com", owner: "owner", name: "repo" };
const mention = { type: "mention", entryId: "entry", name: "prompt", kind: "command" };
const position = { file: "src/file.ts", side: "new", start: 1, end: 1 };
const lane = { provider: "codex", model: "model" };
const template = {
  kind: "fanout",
  lanes: [lane],
  checks: { command: ["check"] },
  budget: { maxLanes: 1, maxDepth: 1, maxAttempts: 1, durationMs: 100, tokens: 100, cost: 1 },
};
const orchestration = {
  type: "orchestration.create",
  input: {
    workspaceId,
    prompt: "work",
    baseRef: "a".repeat(40),
    targetBranch: "main",
    template,
  },
};

const send = { type: "thread.send", threadId, input: [{ type: "text", text: "hi" }] };
const review = { type: "review.comment", sessionId: "review", position, text: "comment" };
const entries = (size: number) =>
  Object.fromEntries(Array.from({ length: size }, (_, i) => [`key${i}`, i]));

export const refinementRejections: Record<string, Record<string, unknown>> = {
  owner_path: {
    type: "thread.create",
    workspaceId,
    provider: "codex",
    input: send.input,
    pullRequest: {
      ref: { repository: { ...repository, owner: "owner/../other" }, number: 1 },
      headSha: "a".repeat(40),
    },
  },
  remote_name: {
    type: "thread.create",
    workspaceId,
    provider: "codex",
    input: send.input,
    base: { ref: "main", remote: "-origin" },
  },
  keys_64: { ...send, input: [{ ...mention, values: entries(65) }] },
  parameter_default: {
    ...send,
    input: [
      {
        ...mention,
        invocation: {
          type: "prompt",
          commandId: "prompt",
          parameters: { count: { type: "number", default: "one" } },
        },
      },
    ],
  },
  line_range: {
    ...send,
    context: { mentions: [{ path: "file", lines: { start: 2, end: 1 } }] },
  },
  keys_32: { ...send, options: entries(33) },
  patch_bytes: {
    type: "thread.merge",
    threadId,
    summary: "summary",
    citations: [{ threadId, itemId: "item" }],
    patch: "🌱".repeat(16_385),
  },
  nonblank: { type: "thread.rename", threadId, title: "\ufeff " },
  reviewers: {
    type: "forge.hosted.review",
    workspaceId,
    pr: { repository, number: 1 },
    action: { kind: "reviewers.request", reviewers: [] },
  },
  no_nul: { type: "git.stage", threadId, paths: ["file\0name"] },
  repository_name: {
    type: "workspace.publish",
    workspaceId,
    input: {
      host: "github.com",
      account: "owner",
      owner: "owner",
      name: "..",
      description: "",
      visibility: "private",
    },
  },
  project_name: { type: "workspace.add", path: "/project", name: "project." },
  url: { type: "workspace.add", path: "/project", icon: "https://[::invalid]/icon.png" },
  model_provider: {
    type: "workspace.update",
    workspaceId,
    name: "project",
    defaults: { model: "model" },
  },
  unlink_selection: { type: "forge.pr.unlink", threadId, number: 1, all: true },
  review_ref: {
    type: "review.open",
    source: {
      workspaceId,
      from: { kind: "commit", ref: "-main" },
      to: { kind: "working-tree" },
    },
  },
  review_line_range: { ...review, position: { ...position, end: 101 } },
  review_path: { ...review, position: { ...position, file: "src/../file.ts" } },
  fingerprint_length: {
    ...review,
    expectedFingerprint: { before: [], lines: ["🌱".repeat(4097)], after: [] },
  },
  orchestration_lanes: {
    ...orchestration,
    input: { ...orchestration.input, template: { ...template, lanes: [lane, lane] } },
  },
  orchestration_command: {
    ...orchestration,
    input: { ...orchestration.input, template: { ...template, checks: { command: [""] } } },
  },
  orchestration_id: { type: "orchestration.cancel", orchestrationId: "constructor" },
  keys_24: {
    ...send,
    type: "thread.address",
    about: "prior",
    to: [{ kind: "bot", id: "bot", name: "Bot", avatar: entries(25) }],
    share: "message",
  },
};

// The first icon alternative requires an HTTP(S) prefix and delegates URL syntax
// to z.url(). Cover inputs that pass its regex but vary at the URL parser.
export const iconUrlCases = [
  "HTTPS://例え.テスト/icon.png",
  "https://0x7f.1/icon.png",
  "https://[::1]:65535/icon.png",
  "https://example.test:65536/icon.png",
  "https://256.0.0.1/icon.png",
  "https://bad%00host/icon.png",
  "https://example.test/\ud800",
  "https://example.test/icon.png\u00a0",
  "https://exa\nmple.test/icon.png",
  "https:example.test/icon.png",
];
