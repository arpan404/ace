import { CliSimVerb } from "@ace/protocol";
import { option, type Args } from "./args.ts";
import { usageFailure } from "./output.ts";

const uiActions = new Set([
  "press",
  "focus",
  "setValue",
  "scroll",
  "expand",
  "select",
  "performSecondaryAction",
  "selectText",
]);
const isRef = (word: string | undefined) => word !== undefined && /^@?e\d+$/.test(word);
/** Whole numbers stay numbers so the tool's schema, not the CLI, judges them. */
function number(word: string | undefined, name: string): number {
  if (word === undefined || !/^-?\d+$/.test(word))
    throw usageFailure(`${name} must be a whole number. See ace help sim act.`);
  return Number(word);
}
function optionalNumber(args: Args, name: string): number | undefined {
  const value = option(args, name);
  return value === undefined ? undefined : number(value, `--${name}`);
}
/** `--value` for ui: JSON for scroll deltas and booleans, otherwise the text itself. */
function uiValue(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  if (raw === "true" || raw === "false" || raw.startsWith("{")) {
    try {
      return JSON.parse(raw);
    } catch {
      throw usageFailure("--value must be valid JSON when it starts with {");
    }
  }
  return raw;
}
const defined = (value: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
/** `@e3` or `X Y`, the two ways tap and long_press name their target. */
function target(words: string[], action: string): Record<string, unknown> {
  if (isRef(words[0]) && words.length === 1) return { ref: words[0] };
  if (words.length === 2) return { x: number(words[0], "X"), y: number(words[1], "Y") };
  throw usageFailure(`${action} takes @ref or X Y. See ace help sim act.`);
}

/** The sim_act arguments for `ace sim act SIM ACTION …`. */
function actArgs(simId: string, action: string, words: string[], args: Args) {
  const duration = optionalNumber(args, "duration");
  if (uiActions.has(action)) {
    if (words.length !== 1 || !isRef(words[0]))
      throw usageFailure(`${action} takes one @ref. See ace help sim act.`);
    return defined({
      simId,
      action: "ui",
      ref: words[0],
      uiAction: action,
      value: uiValue(option(args, "value")),
      name: option(args, "name"),
    });
  }
  const single = (field: string) => {
    if (words.length !== 1) throw usageFailure(`${action} takes one ${field}.`);
    return { simId, action, [field]: words[0] };
  };
  switch (action) {
    case "tap":
      return { simId, action, ...target(words, action) };
    case "long_press":
      return defined({ simId, action, ...target(words, action), durationMs: duration });
    case "swipe": {
      if (words.length !== 4) throw usageFailure("swipe takes X Y TOX TOY.");
      const [x, y, toX, toY] = words.map((word) => number(word, "swipe point"));
      return defined({ simId, action, x, y, toX, toY, durationMs: duration });
    }
    case "type": {
      const ref = isRef(words[0]) && words.length === 2 ? words[0] : undefined;
      const text = ref ? words[1] : words.length === 1 ? words[0] : undefined;
      if (text === undefined) throw usageFailure("type takes [@ref] TEXT.");
      return defined({ simId, action, ref, text });
    }
    case "key":
      return single("key");
    case "open_app":
      return single("appId");
    case "open_url":
      return single("url");
    case "install":
      return single("path");
    case "clipboard_set":
      return single("text");
    case "posture":
      return single("posture");
    case "record_start":
    case "record_stop":
    case "clipboard_get":
      if (words.length) throw usageFailure(`${action} takes no arguments.`);
      return { simId, action };
    default:
      throw usageFailure(`Unknown action ${action}. See ace help sim act.`);
  }
}

/** Pure: `ace sim …` words and flags to the verb and the sim tool's own arguments. */
export function simCall(args: Args): { verb: CliSimVerb; args: Record<string, unknown> } {
  const parsed = CliSimVerb.safeParse(args.words[1]);
  if (!parsed.success) throw usageFailure("Unknown ace sim verb. See ace help sim act.");
  const verb = parsed.data;
  const [simId, ...rest] = args.words.slice(2);
  if (verb === "list") {
    if (simId !== undefined) throw usageFailure("ace sim list takes no arguments.");
    return { verb, args: {} };
  }
  if (simId === undefined) throw usageFailure(`ace sim ${verb} needs a SIM id.`);
  const only = (count: number) => {
    if (rest.length > count) throw usageFailure("Too many arguments. See ace help sim act.");
  };
  switch (verb) {
    case "start":
      only(0);
      return { verb, args: { simId, boot: !args.flags["no-boot"] } };
    case "stop":
    case "screenshot":
      only(0);
      return { verb, args: { simId } };
    case "logs":
      only(0);
      return { verb, args: defined({ simId, limit: optionalNumber(args, "limit") }) };
    case "ui":
      only(1);
      return {
        verb,
        args: defined({
          simId,
          name: rest[0] ?? option(args, "name"),
          text: option(args, "text"),
          role: option(args, "role"),
          limit: optionalNumber(args, "limit"),
          maxDepth: optionalNumber(args, "max-depth"),
          maxNodes: optionalNumber(args, "max-nodes"),
        }),
      };
    case "act": {
      const [action, ...words] = rest;
      if (action === undefined) throw usageFailure("ace sim act needs an ACTION.");
      return { verb, args: actArgs(simId, action, words, args) };
    }
  }
}
