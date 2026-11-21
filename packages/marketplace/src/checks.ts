import { readCheckRule } from "./check-rule.ts";
import { refusal, type Refusal } from "./rules.ts";

/*
 * A package's `checks` (ADR 0204 §3), read the way Spade reads them (`spade_core::package::checks`),
 * with the same sentences, held to it by the conformance suite's `package/checks.json`: `schema`
 * rules on contract outputs and cards, `criterion` lines on the goal. A `code` check needs package
 * code (ADR 0203), which no Spade runs yet, so it is refused rather than passed over. Also `verify`
 * on a schedule, event or webhook trigger. Pure.
 */

export const checkLimits = { checks: 32, on: 8, criteria: 8, nameChars: 40, textChars: 500 };
const fields = new Set(["name", "on", "kind", "rule", "text", "code"]);

type Fields = Record<string, unknown>;
const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const checkName = (name: unknown): name is string =>
  typeof name === "string" &&
  name.length <= checkLimits.nameChars &&
  /^[a-z0-9][a-z0-9-]*$/.test(name);

/** What `bot.json` declares, for the places a check is on. */
export interface CheckPlaces {
  contracts: string[];
  cards: string[];
}

/** The card ids `surfaces` declares, read leniently. */
export function declaredCards(surfaces: unknown): string[] {
  if (!Array.isArray(surfaces)) return [];
  return surfaces.flatMap((surface) =>
    isFields(surface) && surface["kind"] === "card" && typeof surface["id"] === "string"
      ? [surface["id"]]
      : [],
  );
}

/** The contract names `contracts` declares, read leniently. */
export function declaredContracts(contracts: unknown): string[] {
  if (!Array.isArray(contracts)) return [];
  return contracts.flatMap((contract) =>
    isFields(contract) && typeof contract["name"] === "string" ? [contract["name"]] : [],
  );
}

function placeProblems(at: string, raw: unknown, places: CheckPlaces, out: Refusal[]): string[] {
  const words =
    Array.isArray(raw) &&
    raw.length >= 1 &&
    raw.length <= checkLimits.on &&
    raw.every((w) => typeof w === "string")
      ? raw.filter((w): w is string => typeof w === "string")
      : undefined;
  if (!words) {
    out.push(
      refusal(
        "checks.on",
        `${at}.on names 1 to ${checkLimits.on} places: contract:<name>, card:<id> or goal`,
      ),
    );
    return [];
  }
  const on: string[] = [];
  for (const word of words) {
    const colon = word.indexOf(":");
    const [kind, name] = colon < 0 ? [word, ""] : [word.slice(0, colon), word.slice(colon + 1)];
    const known = word === "goal" || ((kind === "contract" || kind === "card") && name !== "");
    if (!known)
      out.push(
        refusal(
          "checks.on",
          `${at}.on: ${JSON.stringify(word)} is contract:<name>, card:<id> or goal`,
        ),
      );
    else if (kind === "contract" && !places.contracts.includes(name))
      out.push(
        refusal(
          "checks.on",
          `${at}.on: ${JSON.stringify(word)} isn't one of the package's contracts`,
        ),
      );
    else if (kind === "card" && !places.cards.includes(name))
      out.push(
        refusal("checks.on", `${at}.on: ${JSON.stringify(word)} isn't one of the package's cards`),
      );
    else if (on.includes(word))
      out.push(refusal("checks.on", `${at}.on names ${JSON.stringify(word)} twice`));
    else on.push(word);
  }
  return on;
}

/** Every problem with `checks`; none when they read. */
export function checkProblems(value: unknown, places: CheckPlaces): Refusal[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > checkLimits.checks)
    return [refusal("checks.list", `checks is a list of at most ${checkLimits.checks}`)];
  const problems: Refusal[] = [];
  const names = new Set<string>();
  let criteria = 0;
  value.forEach((item: unknown, i) => {
    const at = `checks[${i}]`;
    if (!isFields(item)) {
      problems.push(refusal("checks.field", `${at} is an object`));
      return;
    }
    for (const key of Object.keys(item))
      if (!fields.has(key))
        problems.push(
          refusal("checks.field", `${at}: ${JSON.stringify(key)} isn't a field of a check`),
        );
    const name = item["name"];
    if (!checkName(name))
      problems.push(
        refusal("checks.name", `${at}.name is a short name: lower-case letters, digits and dashes`),
      );
    const on = placeProblems(at, item["on"], places, problems);
    switch (item["kind"]) {
      case "schema":
        if (on.includes("goal"))
          problems.push(
            refusal(
              "checks.schema-place",
              `${at}: a schema check is on contracts and cards, not the goal`,
            ),
          );
        if (item["rule"] === undefined)
          problems.push(
            refusal("checks.schema-place", `${at}.rule is the rule the result must hold`),
          );
        else problems.push(...readCheckRule(item["rule"], `${at}.rule`).problems);
        break;
      case "criterion": {
        criteria += 1;
        if (on.length !== 1 || on[0] !== "goal")
          problems.push(
            refusal("checks.criterion", `${at}: a criterion check is on the goal only`),
          );
        const text = item["text"];
        const trimmed = typeof text === "string" ? text.trim() : "";
        if (trimmed === "" || [...trimmed].length > checkLimits.textChars)
          problems.push(
            refusal(
              "checks.criterion",
              `${at}.text says in 1 to ${checkLimits.textChars} characters what must hold`,
            ),
          );
        break;
      }
      case "code":
        problems.push(
          refusal(
            "checks.code-later",
            `${at}: Needs a newer Spade: code checks run once Spade runs a package's code`,
          ),
        );
        break;
      default:
        problems.push(refusal("checks.kind", `${at}.kind is schema, code or criterion`));
    }
    if (checkName(name)) {
      if (names.has(name))
        problems.push(refusal("checks.name-unique", "each check has a name of its own"));
      names.add(name);
    }
  });
  if (criteria > checkLimits.criteria)
    problems.push(
      refusal("checks.criteria", `a package has at most ${checkLimits.criteria} criterion checks`),
    );
  return problems;
}

/** Every problem with `verify` on `triggers`; none when each is true or false on a routine. */
export function verifyProblems(triggers: unknown): Refusal[] {
  if (!Array.isArray(triggers)) return [];
  return triggers.flatMap((trigger: unknown, i) => {
    if (!isFields(trigger) || trigger["verify"] === undefined || trigger["verify"] === false)
      return [];
    if (trigger["verify"] !== true)
      return [refusal("package.trigger", `triggers[${i}].verify is true or false`)];
    return ["schedule", "event", "webhook"].includes(String(trigger["kind"]))
      ? []
      : [
          refusal(
            "package.trigger",
            `triggers[${i}].verify is for a schedule, event or webhook trigger`,
          ),
        ];
  });
}
