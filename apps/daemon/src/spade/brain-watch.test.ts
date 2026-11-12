import { expect, test } from "vitest";
import { AgentId, ItemId, type AgentModelRoster } from "@ace/protocol";
import { subscriptionsFrom } from "./brain-sessions.ts";
import { BrainWatch, failureReason } from "./brain-watch.ts";

const roster = (providers: AgentModelRoster["providers"]): AgentModelRoster => ({
  providers,
  caller: { provider: "codex", access: "read-only" },
});
const sets = [{ ids: ["m1", "m2"], names: { m1: "Model one" } }];

test("subscriptions leave out providers that aren't installed, are turned off or signed out", () => {
  const listed = subscriptionsFrom(
    roster([
      { provider: "codex", accounts: [{ id: "work", label: "Work" }, { id: "home" }], sets },
      { provider: "claude", accounts: [{ id: "c", installed: false }], sets },
      { provider: "cursor", accounts: [{ id: "k", enabled: false }], sets },
      { provider: "opencode", accounts: [{ id: "o", auth: "logged_out" }], sets },
      { provider: "pi", accounts: [{ id: "p", auth: "unknown" }], sets: [] },
    ]),
  );
  expect(listed).toEqual({
    providers: [
      {
        provider: "codex",
        name: "Codex",
        accounts: [
          { id: "work", label: "Work" },
          { id: "home", label: null },
        ],
        models: [
          { id: "m1", name: "Model one" },
          { id: "m2", name: "m2" },
        ],
      },
    ],
  });
});

test("a failed run is named by why: signed out, out of quota, rate-limited, or otherwise", () => {
  const cases = [
    [{ kind: "auth", message: "x" }, "signed_out"],
    [{ kind: "provider", message: "x", code: "authentication_failed" }, "signed_out"],
    [{ kind: "quota", message: "x" }, "quota"],
    [
      { kind: "provider", message: "x", details: { code: "usage_limit", provider: "codex" } },
      "quota",
    ],
    [{ kind: "provider", message: "x", code: "rate_limit" }, "rate_limited"],
    [{ kind: "process_exit", message: "x" }, "failed"],
  ] as const;
  for (const [error, reason] of cases) expect(failureReason(error)).toBe(reason);
});

test("a reply sent whole after it streamed adds only what is new, and a provider question ends the turn", () => {
  const root = AgentId.parse("01a1ceeb-4c59-77b0-b615-357c46c0000f");
  const watch = new BrainWatch(root, "codex");
  const item = (text: string) => ({
    id: ItemId.parse("i1"),
    agentId: root,
    createdAt: 1,
    complete: true,
    type: "message" as const,
    role: "assistant" as const,
    parts: [{ type: "text" as const, text }],
    synthetic: false,
    raw: [],
  });
  const texts = [
    ...watch.next({ type: "item.created", item: item("Hel") }),
    ...watch.next({
      type: "item.delta",
      itemId: ItemId.parse("i1"),
      agentId: root,
      field: "text",
      append: "lo",
    }),
    ...watch.next({ type: "item.updated", item: item("Hello, there") }),
  ].flatMap((frame) => (frame.type === "text" ? [frame.text] : []));
  expect(texts.join("")).toBe("Hello, there");
  const asked = watch.next({
    type: "interaction.opened",
    interaction: { id: "q" } as never,
  });
  expect(asked).toEqual([expect.objectContaining({ type: "failed", reason: "needs_permission" })]);
  expect(watch.ended).toBe(true);
});
