import { z } from "zod";
import { readContracts } from "./contracts.ts";
import {
  PackageEffect,
  PackageEffectWord,
  PackageModule,
  PackageTrigger,
  Recipe,
  type MarketEffectRow,
  type MarketProblem,
} from "@ace/protocol/marketplace";
import { surfaceProblems } from "./surfaces.ts";

/*
 * An agent package's manifest, `bot.json` at version 3 (ADR 0200 §3), read the way Spade reads it
 * (`spade_core::package::read`): schedule triggers become the recipe's routines, as version 2's
 * are, and what a package may never carry refuses the file. Identity is the signed manifest's,
 * executions are plugins', `credential` is never declared, a grant is only one a package may ask
 * for, and the only price is free. Fields this build doesn't know are kept as `extra`, shown as
 * "Not used by this Spade", and grant nothing.
 */

const path = "bot.json";
/** The runtime API's major version this build serves (ADR 0200 §4). */
export const packageRuntime = "1";

const identity = ["publisher", "signature", "signatures", "signed", "hash", "package"];
const executions = [
  "mcpServers",
  "mcp_servers",
  "mcp",
  "servers",
  "hooks",
  "executions",
  "commands",
  "command",
];
const known = new Set([
  "format",
  "version",
  "requires",
  "name",
  "blurb",
  "task",
  "face",
  "style",
  "personality",
  "model",
  "uses",
  "triggers",
  "skills",
  "plugins",
  "needs",
  "effects",
  "limits",
  "tests",
  "notes",
  "pricing",
  "surfaces",
  "contracts",
  ...identity,
  ...executions,
]);

const AnyRecord = z.record(z.string(), z.unknown());
const problem = (message: string): MarketProblem => ({ path, message });

/** A declared effect's switch key, the same as Spade's (`Declared::key`). */
export function effectKey(effect: PackageEffect): string {
  if (effect.hosts?.length) return `${effect.effect}:hosts:${effect.hosts.toSorted().join(",")}`;
  switch (effect.grant?.kind) {
    case "drive_site":
      return `${effect.effect}:drive_site:${effect.grant.host}`;
    case "drive_app":
      return `${effect.effect}:drive_app:${effect.grant.app}`;
    case "tool":
      return `${effect.effect}:tool:${effect.grant.tool}`;
    case undefined:
      return effect.effect;
  }
}

/** Each declared effect as a switch row for the review. */
export function recipeEffects(recipe: Recipe): MarketEffectRow[] {
  return recipe.effects.map((effect) => ({
    key: effectKey(effect),
    effect: effect.effect,
    ...(effect.hosts ? { hosts: effect.hosts } : {}),
    ...(effect.grant ? { grant: effect.grant } : {}),
    why: effect.why,
  }));
}

/** The switches the person left on: a missing switch is off, a key not declared turns nothing on. */
export function grantedEffects(
  recipe: Recipe,
  switches: Readonly<Record<string, boolean>>,
): Record<string, boolean> {
  return Object.fromEntries(
    recipeEffects(recipe).map((row) => [row.key, switches[row.key] === true]),
  );
}

const versionParts = (version: string) =>
  version
    .replace(/^v/, "")
    .split(/[.+-]/)
    .map((part) => Number(part))
    .filter((part) => Number.isInteger(part));

function newer(wanted: string, have: string): boolean {
  const parts = versionParts;
  const [a, b] = [parts(wanted), parts(have)];
  for (let at = 0; at < Math.max(a.length, b.length); at++) {
    const [x, y] = [a[at] ?? -1, b[at] ?? -1];
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Spade's own tools that send in the person's name (`spade_core::effect`'s table): a `tool` grant
 * of one is never made, as Spade's reader refuses it. the conformance suite (`spade/spec/conformance/`) holds both readers to this.
 */
const sendingTools = new Set(["git_push", "pr_comment", "issue_comment", "send_message"]);

function effectProblems(raw: unknown, at: string): MarketProblem[] {
  const entry = AnyRecord.safeParse(raw);
  if (!entry.success) return [problem(`${at} is an object`)];
  const word = entry.data["effect"];
  // Every bot reads and writes its own folder: declaring that changes nothing.
  if (word === "read" || word === "write_local") return [];
  if (word === "credential")
    return [problem(`${at}: credential can't be declared; Spade never hands a bot a secret`)];
  if (word === "drive")
    return [
      problem(
        `${at}: driving a page or app is declared as network with a drive_app or drive_site grant`,
      ),
    ];
  if (!PackageEffectWord.safeParse(word).success)
    return [
      problem(
        `${at}: ${JSON.stringify(word)} isn't an effect; use network, publish, send_as_person, pay or change_access`,
      ),
    ];
  const problems: MarketProblem[] = [];
  const why = entry.data["why"];
  // Spade's sentence (`spade_core::package::manifest`): the review shows it beside the switch.
  if (typeof why !== "string" || !why.trim())
    problems.push(problem(`${at}.why says in a sentence why it needs this`));
  if (entry.data["hosts"] !== undefined && word !== "network")
    problems.push(problem(`${at}: only network names hosts`));
  const grant = AnyRecord.safeParse(entry.data["grant"]);
  if (grant.success) {
    if (word !== "network" && word !== "publish")
      problems.push(problem(`${at}: ${String(word)} is never granted; it goes to you every time`));
    const kind = grant.data["kind"];
    if (kind === "git_push" || kind === "pr_comment" || kind === "folder")
      problems.push(
        problem(
          `${at}: a package can't ask for a push, a comment or a folder; those are yours to give`,
        ),
      );
    const tool = grant.data["tool"];
    if (kind === "tool" && typeof tool === "string" && sendingTools.has(tool))
      problems.push(
        problem(
          `${at}: ${tool} sends something in the person's name. That always goes to the person.`,
        ),
      );
    if (entry.data["hosts"] !== undefined)
      problems.push(problem(`${at} asks for hosts or a grant, not both`));
  }
  return problems;
}

/** Zod's issues as sentences, less what the effect and surface checks say better. */
function issues(error: z.ZodError): MarketProblem[] {
  return error.issues
    .filter(
      (issue) =>
        !(issue.path[0] === "effects" && (issue.path[2] === "why" || issue.path[2] === "effect")) &&
        // `surfaceProblems` says what's wrong with a surface, in Spade's words.
        issue.path[0] !== "surfaces",
    )
    .slice(0, 20)
    .map((issue) => problem(`${issue.path.join(".") || "bot.json"}: ${issue.message}`));
}

export interface PackageReading {
  recipe: Recipe | undefined;
  problems: MarketProblem[];
}

/** `bot.json` at version 3, as the recipe it installs; every problem that refuses it otherwise. */
export function readPackage(
  json: Record<string, unknown>,
  options: { spade?: string | undefined } = {},
): PackageReading {
  const problems: MarketProblem[] = [];
  for (const field of identity)
    if (field in json)
      problems.push(
        problem(
          `${field}: who published a package and which version it is come from the market's signed manifest, never from bot.json`,
        ),
      );
  for (const field of executions)
    if (field in json)
      problems.push(
        problem(
          `${field}: a package never carries servers, hooks or commands; name a plugin instead`,
        ),
      );
  const pricing = AnyRecord.safeParse(json["pricing"]);
  if (json["pricing"] !== undefined && (!pricing.success || pricing.data["kind"] !== "free"))
    problems.push(problem("Paid packages aren't offered yet."));
  const requires = AnyRecord.safeParse(json["requires"]);
  if (requires.success) {
    const runtime = requires.data["runtime"];
    if (runtime !== undefined && typeof runtime !== "string")
      problems.push(problem(`requires.runtime is a string, like "${packageRuntime}"`));
    else if (runtime !== undefined && runtime !== packageRuntime)
      problems.push(
        problem(
          `Needs a newer Spade: it asks for runtime ${JSON.stringify(String(runtime))}, and this one serves ${packageRuntime}`,
        ),
      );
    const spade = requires.data["spade"];
    if (typeof spade === "string" && options.spade && newer(spade, options.spade))
      problems.push(problem(`Needs a newer Spade: ${spade} or later`));
  }
  if (Array.isArray(json["uses"]))
    for (const module of json["uses"])
      if (!PackageModule.safeParse(module).success)
        problems.push(
          problem(`Needs a newer Spade: this one has no ${JSON.stringify(module)} module`),
        );
  // The raw shape first, as Spade's reader checks it: a list where a list is meant, never an
  // object or a word read as nothing.
  for (const [field, most] of [
    ["effects", 32],
    ["triggers", 40],
  ] as const) {
    const raw = json[field];
    if (raw !== undefined && (!Array.isArray(raw) || raw.length > most))
      problems.push(problem(`${field} is a list of at most ${most}`));
  }
  for (const message of surfaceProblems(json["surfaces"])) problems.push(problem(message));
  if (json["uses"] !== undefined && !Array.isArray(json["uses"]))
    problems.push(problem("uses lists runtime modules"));
  const effects: unknown[] = Array.isArray(json["effects"]) ? json["effects"] : [];
  const kept: unknown[] = [];
  effects.forEach((raw, at) => {
    const found = effectProblems(raw, `effects[${at}]`);
    problems.push(...found);
    const word = AnyRecord.safeParse(raw).data?.["effect"];
    // Every bot reads and writes its own folder: declaring that changes nothing.
    if (word !== "read" && word !== "write_local") kept.push(raw);
  });
  const routines: unknown[] = [];
  const triggers: unknown[] = [];
  const rawTriggers: unknown[] = Array.isArray(json["triggers"])
    ? json["triggers"]
    : json["triggers"] === undefined
      ? [{ kind: "message" }]
      : [];
  for (const raw of rawTriggers) {
    const trigger = AnyRecord.safeParse(raw);
    const kind = trigger.data?.["kind"];
    if (kind === "schedule" && trigger.data) {
      const { kind: _kind, ...routine } = trigger.data;
      routines.push(routine);
    } else if (["message", "mention", "event", "webhook"].includes(String(kind)))
      triggers.push(raw);
    // Contract calls (phase 2) and kinds a later build adds: kept in the file, not used.
  }
  // Typed calls other agents of the person may make (ADR 0200 §7), within the declared effects.
  const declared = effects.flatMap((raw) => {
    const word = AnyRecord.safeParse(raw).data?.["effect"];
    return typeof word === "string" ? [word] : [];
  });
  const contracts = readContracts(json["contracts"], declared);
  problems.push(...contracts.problems.map(problem));
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(json)) if (!known.has(key)) extra[key] = value;
  const {
    triggers: _triggers,
    effects: _effects,
    pricing: _pricing,
    contracts: _contracts,
    ...rest
  } = json;
  for (const field of [...identity, ...executions, ...Object.keys(extra)])
    delete (rest as Record<string, unknown>)[field];
  const read = Recipe.safeParse({
    ...rest,
    routines,
    triggers,
    effects: kept,
    ...(contracts.problems.length ? {} : { contracts: contracts.kept }),
  });
  if (!read.success) return { recipe: undefined, problems: [...problems, ...issues(read.error)] };
  const recipe: Recipe = Object.keys(extra).length ? { ...read.data, extra } : read.data;
  const names = [
    ...recipe.routines.map((routine) => routine.name),
    ...recipe.triggers.flatMap((trigger) => ("name" in trigger ? [trigger.name] : [])),
  ];
  if (names.length > 32) problems.push(problem("a package has at most 32 routines"));
  if (new Set(names).size !== names.length)
    problems.push(problem("each routine has a name of its own"));
  const keys = recipe.effects.map(effectKey);
  if (new Set(keys).size !== keys.length) problems.push(problem("an effect is declared twice"));
  return { recipe, problems };
}

/** A version 3 trigger other than a schedule, re-exported for the review's rows. */
export type { PackageTrigger };
