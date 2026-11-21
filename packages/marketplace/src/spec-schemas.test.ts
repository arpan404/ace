import { readdirSync, readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

/*
 * The Spade Agent Format's JSON Schemas (`spade/spec/schemas/`, written from Spade's data, ADR
 * 0201 §4), checked by a validator that knows nothing of Spade: each accepts every case a reader
 * MUST accept, and refuses every case whose rule the schema alone decides (`schema` in
 * `rules.json`). What a schema can't decide (another file, the runtime's build, a comparison
 * across fields) stays with the reader.
 */

const spec = new URL("../../../spade/spec/", import.meta.url);
const json = (path: string) => JSON.parse(readFileSync(new URL(path, spec), "utf8")) as unknown;

interface Case {
  id: string;
  with?: Record<string, unknown>;
  schema?: unknown;
  rule?: string;
  files?: Record<string, string>;
}
interface Suite {
  base: Record<string, unknown>;
  cases: Case[];
}

const ajv = new Ajv2020({ allErrors: true });
for (const name of readdirSync(new URL("schemas/", spec)))
  ajv.addSchema(json(`schemas/${name}`) as object);
const base = "https://spec.acehq.dev/1.0/";
const validator = (ref: string) => {
  const found = ajv.getSchema(`${base}${ref}`);
  if (!found) throw new Error(`no schema ${ref}`);
  return found;
};
const bot = validator("bot.schema.json");
const subset = validator("contract.schema.json#/$defs/schema");
const scenario = validator("scenario.schema.json");
const surface = validator("surface.schema.json");

const decides = new Map(
  (json("conformance/rules.json") as { rules: { id: string; schema: boolean }[] }).rules.map(
    (rule) => [rule.id, rule.schema],
  ),
);

const manifests = ["package", "effects", "contracts", "surfaces", "code"].flatMap((part) => {
  const suite = json(`conformance/${part}/manifests.json`) as Suite;
  // A case whose decisive part is another file of the package is the reader's: bot.json's
  // schema sees bot.json alone.
  return suite.cases.map(
    (c) => [c.id, { ...suite.base, ...c.with }, c.files ? undefined : c.rule, c.rule] as const,
  );
});

describe("bot.schema.json", () => {
  it.each(manifests.filter(([, , , rule]) => rule === undefined))(
    "accepts %s, which a reader accepts",
    (_id, manifest) => {
      expect(bot(manifest), JSON.stringify(bot.errors)).toBe(true);
    },
  );

  it.each(manifests.filter(([, , rule]) => rule !== undefined && decides.get(rule) === true))(
    "refuses %s, whose rule it decides",
    (_id, manifest) => {
      expect(bot(manifest)).toBe(false);
    },
  );

  it("decides at least one refusal of every part", () => {
    const decided = manifests.filter(([, , rule]) => rule && decides.get(rule));
    for (const part of ["package", "effects", "contracts", "surfaces", "code"])
      expect(decided.some(([id]) => id.startsWith(`${part}/`))).toBe(true);
  });
});

describe("the bounded schema subset, as a schema", () => {
  const cases = (json("conformance/contracts/schemas.json") as { cases: Case[] }).cases;
  it.each(cases.filter((c) => c.rule === undefined).map((c) => [c.id, c] as const))(
    "accepts %s",
    (_id, c) => {
      expect(subset(c.schema), JSON.stringify(subset.errors)).toBe(true);
    },
  );
  it.each(
    cases.filter((c) => c.rule && decides.get(c.rule) === true).map((c) => [c.id, c] as const),
  )("refuses %s", (_id, c) => {
    expect(subset(c.schema)).toBe(false);
  });
});

describe("scenario.schema.json and surface.schema.json", () => {
  it("accept every scenario the suite and the shipped templates run", () => {
    const runtime = json("conformance/runtime/scenarios.json") as {
      cases: { scenario: unknown }[];
    };
    const cards = json("conformance/surfaces/cards.json") as { cases: { scenario: unknown }[] };
    const templates = new URL("../templates/", spec);
    const shipped = readdirSync(templates).flatMap((id) => {
      const tests = new URL(`${id}/tests/`, templates);
      try {
        return readdirSync(tests).map(
          (file) => JSON.parse(readFileSync(new URL(file, tests), "utf8")) as unknown,
        );
      } catch {
        return [];
      }
    });
    const all = [...runtime.cases, ...cards.cases].map((c) => c.scenario).concat(shipped);
    expect(shipped.length).toBeGreaterThan(0);
    for (const one of all) expect(scenario(one), JSON.stringify(scenario.errors)).toBe(true);
    expect(scenario({ name: "No run", given: {}, model: [], extra: true })).toBe(false);
  });

  it("accept a panel the suite installs, and refuse a surface of a kind the format lacks", () => {
    const panels = json("conformance/surfaces/panels.json") as Suite;
    const declared = (panels.base["surfaces"] as unknown[])[0];
    expect(surface(declared), JSON.stringify(surface.errors)).toBe(true);
    expect(surface({ id: "wall", kind: "billboard" })).toBe(false);
  });
});
