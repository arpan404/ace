import { expect, test } from "vitest";
import { CommandPayload, ThreadId } from "@ace/protocol";
import { providerCommandDisabled, type ProviderAdmissionFacts } from "@ace/core";

const parent = ThreadId.parse("parent");
const fork = ThreadId.parse("fork");
const facts: ProviderAdmissionFacts = {
  thread: (id) =>
    id === parent
      ? { provider: "codex", instanceId: "blocked" }
      : id === fork
        ? { provider: "claude", instanceId: "allowed", parentThreadId: parent }
        : undefined,
  defaultInstance: () => "blocked",
  enabled: (_provider, instance) => instance !== "blocked",
};
const disabled = (payload: unknown) =>
  providerCommandDisabled(CommandPayload.parse(payload), facts);

test("new work checks the selected default account unless an explicit account replaces it", () => {
  const create = {
    type: "thread.create",
    provider: "codex",
    workspaceId: "workspace",
    input: [{ type: "text", text: "new" }],
  };
  expect(disabled(create)).toBe(true);
  for (const account of [
    { accountId: "allowed" },
    { account: "allowed" },
    { instanceId: "allowed", acpAgentId: "local:agent", installationId: "install" },
  ])
    expect(disabled({ ...create, ...account })).toBe(false);
});

test("switching providers uses the destination default account and preserves explicit selection", () => {
  expect(
    disabled({ type: "thread.switch", threadId: fork, selection: { provider: "codex" } }),
  ).toBe(true);
  expect(
    disabled({
      type: "thread.switch",
      threadId: parent,
      selection: { provider: "claude", instanceId: "allowed" },
    }),
  ).toBe(false);
  expect(
    disabled({
      type: "thread.fork",
      threadId: parent,
      point: { type: "turn", runId: "run" },
      input: "fork",
      selection: { provider: "claude", instanceId: "allowed" },
    }),
  ).toBe(false);
});

test("merges require both source and destination accounts while stop commands remain available", () => {
  const merge = {
    type: "thread.merge",
    threadId: fork,
    summary: "result",
    citations: [{ threadId: fork, itemId: "item" }],
  };
  expect(disabled(merge)).toBe(true);
  expect(
    providerCommandDisabled(CommandPayload.parse(merge), { ...facts, enabled: () => true }),
  ).toBe(false);
  expect(
    disabled({ type: "thread.send", threadId: parent, input: [{ type: "text", text: "next" }] }),
  ).toBe(true);
  expect(disabled({ type: "thread.interrupt", threadId: parent })).toBe(false);
  expect(disabled({ type: "thread.archive", threadId: parent })).toBe(false);
});
