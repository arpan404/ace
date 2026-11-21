import { Command, Interaction } from "@ace/protocol";
import { expect, test } from "vitest";
import { unreadAnswer } from "./unread-answers.ts";

/*
 * An answer naming the version it was shown (`readWhole`) goes only while the request still reads
 * under that version, whatever the request's size now.
 */

const asked = (description: string) =>
  Interaction.parse({
    id: "ask",
    threadId: "thread",
    agentId: "root",
    blocking: true,
    state: "pending",
    createdAt: 1,
    request: {
      kind: "approval",
      title: "Run the migration",
      description,
      target: { tool: "Bash", command: "bun migrate.ts", access: "execute" },
      options: [
        { id: "allow", label: "Allow once", kind: "allow_once" },
        { id: "deny", label: "Deny", kind: "deny" },
      ],
    },
  });

const store = (interaction: Interaction, version: string) => ({
  getInteraction: (id: string) => (id === interaction.id ? interaction : undefined),
  interactionRequestVersion: () => version,
});

const answer = (optionId: string, readWhole?: string) =>
  Command.parse({
    id: "answer",
    deviceId: "phone",
    payload: {
      type: "interaction.resolve",
      interactionId: "ask",
      resolution: { kind: "approval", optionId },
      ...(readWhole === undefined ? {} : { readWhole }),
    },
  });

const large = "d".repeat(400 * 1024);

test("a yes to a large request goes only with the version it reads under now", () => {
  const now = store(asked(large), "v-now");
  expect(unreadAnswer(answer("allow", "v-now"), now)).toBeUndefined();
  expect(unreadAnswer(answer("allow", "v-old"), now)).toMatchObject({
    ok: false,
    error: "request_not_read",
  });
  expect(unreadAnswer(answer("allow"), now)).toMatchObject({ ok: false });
});

test("an answer naming a version the request was replaced since is refused, even once small", () => {
  // Read whole while large, then replaced by a small request the person never saw.
  const replaced = store(asked("Run only the first partition"), "v-small");
  expect(unreadAnswer(answer("allow", "v-large"), replaced)).toMatchObject({
    ok: false,
    error: "request_not_read",
  });
  expect(unreadAnswer(answer("deny", "v-large"), replaced)).toMatchObject({ ok: false });
});

test("a small request is answered without a version, and with the one it reads under", () => {
  const small = store(asked("Run only the first partition"), "v-small");
  expect(unreadAnswer(answer("allow"), small)).toBeUndefined();
  expect(unreadAnswer(answer("deny"), small)).toBeUndefined();
  expect(unreadAnswer(answer("allow", "v-small"), small)).toBeUndefined();
});
