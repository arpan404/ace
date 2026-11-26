import type { FakeSpadeAnswer } from "./spade.ts";

type Json = Record<string, unknown>;

/*
 * The composer's `/` menu, as Spade answers it: the skill store's skills and commands (a command
 * is a manual skill) listed for a bot, and a message that starts one (`invoke`), refused unless
 * the store has it. As Spade, the stored message carries what it started, with the text the model
 * reads (`spade_core::invoke::render`).
 */

const reply = (body: unknown, status = 200): FakeSpadeAnswer => ({
  status,
  body: JSON.stringify(body),
});
const problem = (status: number, error: string): FakeSpadeAnswer => reply({ error }, status);

const sources: Record<string, string> = { spade: "Spade", ace: "ace", market: "Store" };

export function fakeInvocables(store: { skills: Json[] }): FakeSpadeAnswer {
  const row = (skill: Json) => ({
    kind: skill.manual === true ? "command" : "skill",
    id: skill.id,
    name: skill.name,
    description: skill.description,
    source: String(skill.source ?? sources[String(skill.origin)] ?? "ace"),
  });
  const all = store.skills.map(row);
  return reply({
    invocables: [
      ...all.filter((each) => each.kind === "skill"),
      ...all.filter((each) => each.kind === "command"),
    ],
  });
}

/** What a message stores for `invoke`, or why Spade refuses it. */
export function fakeInvoked(
  store: { skills: Json[] },
  body: Json,
): { invoke?: Json } | FakeSpadeAnswer {
  const request = body.invoke as Json | undefined;
  if (!request) return {};
  const command = request.kind === "command";
  const skill = store.skills.find(
    (each) => each.id === request.id && (each.manual === true) === command,
  );
  if (!skill || (request.kind !== "skill" && !command))
    return problem(422, `this bot may not use a ${String(request.kind)} with that id`);
  const args = String(request.args ?? body.text ?? "").trim();
  const template = String(skill.text ?? `Follow ${String(skill.name)}.`);
  const text = template.includes("$ARGUMENTS")
    ? template.replaceAll("$ARGUMENTS", args)
    : args
      ? `${template}\n\nARGUMENTS: ${args}`
      : template;
  return {
    invoke: {
      kind: request.kind,
      id: skill.id,
      name: skill.name,
      ...(args ? { args } : {}),
      text,
    },
  };
}
