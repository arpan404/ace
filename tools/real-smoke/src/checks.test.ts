import { describe, expect, test } from "vitest";
import { checkLog, checkPage, checkRss, type PageFacts } from "./checks.ts";
import { smokeMessage } from "./policy.ts";
import { scrubber } from "./report.ts";

const clean = (): PageFacts => ({
  text: "Ready",
  titles: [],
  bubbles: [],
  models: [],
  alerts: [],
  icons: [],
  catalogsReady: true,
  expected: {},
});
describe("presentation failures", () => {
  test.each([
    ["wrapper-tag", "<recommended_plugins>example</recommended_plugins>"],
    ["ansi-escape", "\u001b[31mred"],
    ["omitted-object", "UNPREPARED OBJECT OMITTED"],
    ["raw-event-prefix", "thread.started: native state"],
    ["local-hostname", "arpans-mac.local"],
    ["bare-unavailable", "Ready\nUnavailable\n"],
  ])("rejects visible %s", (code, text) => {
    expect(checkPage({ ...clean(), text }).map((failure) => failure.code)).toContain(code);
  });
  test("rejects JSON prose and raw model labels but allows model ids in code examples", () => {
    expect(
      checkPage({
        ...clean(),
        bubbles: ['{"type":"event_msg","data":{}}'],
        models: ["gpt-5.4-mini", "o4-mini"],
      }).map((failure) => failure.code),
    ).toEqual(["json-bubble", "raw-model-id"]);
    expect(
      checkPage({ ...clean(), text: "Use gpt-5.4-mini in a script", models: ["GPT 5.4 Mini"] }),
    ).toEqual([]);
  });
  test("requires known provider icons to contain the mark", () => {
    expect(checkPage({ ...clean(), icons: [{ name: "Codex", brand: false }] })).toEqual([
      { code: "provider-icon", message: "The Codex icon has no brand mark" },
    ]);
    expect(checkPage({ ...clean(), icons: [{ name: "Codex", brand: true }] })).toEqual([]);
  });
  test("rejects contradictory latest state and duplicate queue state for one text", () => {
    const thread = {
      title: "New thread",
      sent: true,
      current: "Working",
      latest: "Not sent",
      queued: [
        { text: "Fix it", state: "queued" },
        { text: "Fix it", state: "uncertain" },
      ],
    };
    expect(checkPage({ ...clean(), thread }).map((failure) => failure.code)).toEqual([
      "untitled-sent-thread",
      "contradictory-state",
      "contradictory-queue",
    ]);
    expect(
      checkPage({
        ...clean(),
        thread: {
          ...thread,
          title: "Fix it",
          latest: "Previous turn completed",
          queued: [
            { text: "First task", state: "queued" },
            { text: "Second task", state: "uncertain" },
          ],
        },
      }),
    ).toEqual([]);
  });
  test("catalog readiness makes a persistent empty state fail", () => {
    const facts = { ...clean(), text: "No models available", expected: { models: true } };
    expect(checkPage({ ...facts, catalogsReady: false })).toEqual([]);
    expect(checkPage(facts).map((failure) => failure.code)).toEqual(["empty-models"]);
  });
  test("fails visible error banners", () => {
    expect(
      checkPage({ ...clean(), alerts: ["Past sessions couldn't be loaded"] }).map(
        (failure) => failure.code,
      ),
    ).toEqual(["error-surface"]);
  });
});
test("allows only the benign Copilot no-models warning and enforces idle memory", () => {
  expect(
    checkLog({
      level: "warn",
      message: "No chat models",
      fields: { source: "github-copilot", code: "no_models" },
    }),
  ).toEqual([]);
  expect(
    checkLog({
      level: "error",
      message: "No chat models",
      fields: { source: "github-copilot", code: "no_models" },
    }),
  ).toHaveLength(1);
  expect(
    checkLog({
      level: "warn",
      message: "No chat models",
      fields: { source: "openai", code: "no_models" },
    }),
  ).toHaveLength(1);
  expect(checkRss(256)).toEqual([]);
  expect(checkRss(257)).toHaveLength(1);
});
test.each([
  {
    type: "command",
    command: {
      id: "smoke",
      deviceId: "smoke",
      payload: {
        type: "thread.send",
        threadId: "thread",
        input: [{ type: "text", text: "Never send" }],
      },
    },
  },
  { type: "history.continue", threadId: "thread", mode: "resume", input: [], delivery: "queue" },
  { type: "provider.login.start", requestId: "smoke", provider: "claude" },
  { type: "provider.install.run", requestId: "smoke", provider: "claude" },
  {
    type: "settings.set",
    requestId: "smoke",
    key: "automations.enabled",
    value: true,
    layer: { kind: "global" },
  },
  {
    type: "screen.request",
    requestId: "smoke",
    operation: { op: "open.app", bundleId: "com.apple.Terminal" },
  },
  {
    type: "pluginRequest",
    requestId: "smoke",
    request: { type: "plugins.remove", name: "example" },
  },
])("refuses provider execution and mutations before transmission", (message) => {
  expect(() => smokeMessage(message)).toThrow();
});
test("allows automatic UI reads without granting execution or plugin changes", () => {
  const messages = [
    { type: "screen.request", requestId: "smoke", operation: { op: "sessions" } },
    { type: "pluginRequest", requestId: "smoke", request: { type: "plugins.catalog" } },
    {
      type: "context.request",
      requestId: "smoke",
      operation: { op: "attachment.read", threadId: "thread", sha256: "a".repeat(64) },
    },
    {
      type: "command",
      command: {
        id: "smoke",
        deviceId: "smoke",
        payload: { type: "thread.markRead", threadId: "thread", lastSeenSeq: 10 },
      },
    },
  ];
  for (const message of messages) expect(smokeMessage(message).type).toBe(message.type);
});
test("allows scanning and importing into the guarded daemon", () => {
  expect(smokeMessage({ type: "history.scan", action: "start" }).type).toBe("history.scan");
  expect(
    smokeMessage({ type: "history.import", sourceId: "session", workspaceId: "scratch-workspace" })
      .type,
  ).toBe("history.import");
});
test("redacts URL tokens and secrets before artifacts are written", () => {
  const scrub = scrubber("a".repeat(64));
  expect(scrub(`ws://127.0.0.1:1234/#token=${"a".repeat(64)} sk-${"x".repeat(30)}`)).not.toContain(
    "a".repeat(64),
  );
  expect(scrub(`sk-${"x".repeat(30)}`)).not.toContain("x".repeat(30));
});
