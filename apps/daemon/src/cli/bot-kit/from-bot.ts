import type { ScaffoldFile } from "./scaffold.ts";

/*
 * What `ace bot init --from BOT` writes (ADR 0200 §9), decided without I/O: Spade's draft of one of
 * the person's bots (`GET /v1/agents/{id}/package-draft`) as a package folder. Spade already left
 * out what a package never carries (the conversation, notes, knowledge, workspace files, keys,
 * grants, a webhook's secret); this adds a starter scenario, a README that says what to finish, and
 * marks every sentence the developer still has to write with TODO, which `ace bot check` warns on.
 */

type Fields = Record<string, unknown>;

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The scenario every package made from a bot starts with: it answers when written to. */
const FIRST_TEST = "tests/first-message.json";

/** A bot of the person's, as `GET /v1/agents` lists it. */
export interface ListedBot {
  readonly id: string;
  readonly name: string;
}

/** The person's bots (not Spade itself) in `GET /v1/agents`'s answer. */
export function listedBots(answer: unknown): ListedBot[] {
  const list = isFields(answer) && Array.isArray(answer["agents"]) ? answer["agents"] : [];
  return list.flatMap((agent: unknown) => {
    if (!isFields(agent) || agent["kind"] === "main") return [];
    const { id, name } = agent;
    return typeof id === "string" ? [{ id, name: typeof name === "string" ? name : id }] : [];
  });
}

/** The bots `wanted` names: by id, else by name ignoring case. */
export function botsNamed(bots: readonly ListedBot[], wanted: string): ListedBot[] {
  const byId = bots.filter((bot) => bot.id === wanted);
  if (byId.length > 0) return byId;
  const name = wanted.trim().toLowerCase();
  return bots.filter((bot) => bot.name.trim().toLowerCase() === name);
}

export interface Draft {
  readonly manifest: Fields;
  readonly leftOut: string[];
}

/** Spade's answer to `package-draft`, or undefined when it isn't one. */
export function draftOf(answer: unknown): Draft | undefined {
  if (!isFields(answer) || !isFields(answer["recipe"])) return undefined;
  const leftOut = Array.isArray(answer["left_out"])
    ? answer["left_out"].filter((line): line is string => typeof line === "string")
    : [];
  return { manifest: answer["recipe"], leftOut };
}

/** The package folder's files from a draft, named `name` (the bot's own name otherwise). */
export function packageFiles(draft: Draft, name?: string): { name: string; files: ScaffoldFile[] } {
  const manifest: Fields = { ...draft.manifest };
  const called = name?.trim() || String(manifest["name"] ?? "").trim() || "Bot";
  manifest["name"] = called;
  if (typeof manifest["blurb"] !== "string" || !manifest["blurb"].trim())
    manifest["blurb"] = `TODO: one line about what ${called} does, shown under its name.`;
  manifest["tests"] = [FIRST_TEST];
  const effects = Array.isArray(manifest["effects"]) ? manifest["effects"] : [];
  const scenario = {
    name: `${called} answers when written to`,
    given: { message: "Hello. What do you do?" },
    model: [{ say: `Hello, I'm ${called}.` }],
    expect: { reply_contains: [called] },
  };
  const readme = [
    `# ${called}`,
    "",
    `Made from your bot ${called} with \`ace bot init --from\`. Its conversation, notes, knowledge,`,
    "workspace files, keys and grants stayed with the bot.",
    "",
    "## Before you publish",
    "",
    "- Replace each TODO in `bot.json`: the blurb, and the `why` of every effect, which the install",
    "  review shows beside its switch.",
    ...(effects.length > 0
      ? [
          "- Each effect is one the bot's calls had. Take out any it doesn't need; give `network` the",
          "  `hosts` it reads from, so the review can start it on.",
        ]
      : []),
    `- \`${FIRST_TEST}\` only checks that it answers. Add a scenario for each thing it does.`,
    "- Then `ace bot check` and `ace bot test`, and try it with `ace bot dev`.",
    ...(draft.leftOut.length > 0
      ? ["", "## Not carried over", "", ...draft.leftOut.map((line) => `- ${line}`)]
      : []),
    "",
  ].join("\n");
  return {
    name: called,
    files: [
      { path: "bot.json", text: json(manifest) },
      { path: "README.md", text: readme },
      { path: FIRST_TEST, text: json(scenario) },
    ],
  };
}
