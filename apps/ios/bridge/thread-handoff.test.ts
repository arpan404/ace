import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import { connect, fixture, open, reset, rows, until } from "./thread-harness.ts";

/*
 * A thread that moved to another provider shows the phone the same handoff divider as the web:
 * the models whose work carried over and the one taking it, never the context text as a bubble.
 * Over the real SDK and the fake daemon; no provider CLI runs.
 */

afterEach(reset);

const block = [
  '<ace_context_handoff source_thread="moved" through_seq="9">',
  "Context handoff. You are continuing a conversation that gpt-6.1-sol on codex worked on before you.",
  "Earlier items left out: 0.",
  "",
  "--- item ask",
  "user: Fix the export",
  "</ace_context_handoff>",
].join("\n");

test("a context handoff reaches the phone as a divider naming every model, not a bubble", async () => {
  const fake = fixture();
  fake.createThread({ id: "moved", workspaceId: "ace", title: "Moved", provider: "claude" });
  fake.apply("moved", [
    facts.rootAgent("claude"),
    facts.message("root", "ask", "user", "Fix the export"),
    {
      type: "item.upsert",
      agent: "root",
      item: "handoff:switch",
      draft: {
        type: "message",
        role: "user",
        synthetic: true,
        complete: true,
        parts: [{ type: "text", text: block }],
        origin: {
          kind: "handoff",
          from: { provider: "opencode", model: "muse-spark-1.3-contributor" },
          to: { provider: "claude", model: "claude-opus-5-5" },
          sources: [
            { provider: "codex", model: "gpt-6.1-sol" },
            { provider: "opencode", model: "muse-spark-1.3-contributor" },
          ],
          lossy: true,
        },
      },
    },
  ]);
  open(connect(fake), "moved");
  const row = await until(
    () => rows("thread.item").find((item) => item.handoff),
    "the handoff row",
  );
  const handoff = row.handoff as {
    label: string;
    from: { provider: string; name: string }[];
    to: { provider: string; name: string };
  };
  expect(handoff.label).toBe("Context handoff");
  expect(handoff.from.map((side) => side.provider)).toEqual(["codex", "opencode"]);
  expect(handoff.to.provider).toBe("claude");
  expect(row.text).toBe(
    `Context handoff: ${handoff.from.map((side) => side.name).join(", ")} → ${handoff.to.name}`,
  );
  expect(String(row.text)).not.toContain("ace_context_handoff");
  const ask = rows("thread.item").find((item) => item.id !== row.id && item.role === "user");
  expect(ask?.handoff).toBeNull();
});
