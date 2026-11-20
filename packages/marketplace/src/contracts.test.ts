import type { PackageContract } from "@ace/protocol/marketplace";
import { describe, expect, it } from "vitest";
import { breakingChanges } from "./contracts.ts";

const fare = (change: Partial<PackageContract> = {}): PackageContract => ({
  name: "cheapest_fare",
  summary: "The cheapest fare seen for a route this week.",
  input: {
    type: "object",
    properties: {
      from: { type: "string", minLength: 3, maxLength: 3 },
      to: { type: "string", minLength: 3, maxLength: 3 },
      month: { type: "string", maxLength: 7 },
      direct: { type: "boolean" },
    },
    required: ["from", "to"],
  },
  output: {
    type: "object",
    properties: {
      fare: { type: "number", minimum: 0 },
      currency: { enum: ["USD", "NPR"] },
      carrier: { type: "string", maxLength: 80 },
    },
    required: ["fare", "currency"],
  },
  effects: [],
  examples: [],
  ...change,
});

interface Field {
  [key: string]: unknown;
  maxLength?: number;
  minimum?: number;
  enum?: string[];
}
/** A schema's object as a test edits it. */
interface Shape {
  properties: Record<string, Field>;
  required: string[];
  field(name: string): Field;
}
const shape = (schema: Record<string, unknown>): Shape => {
  const edited = schema as unknown as Omit<Shape, "field">;
  return {
    properties: edited.properties,
    get required() {
      return edited.required;
    },
    set required(names: string[]) {
      edited.required = names;
    },
    field(name: string) {
      const found = edited.properties[name];
      if (!found) throw new Error(`no field ${name}`);
      return found;
    },
  };
};
const withInput = (edit: (input: Shape) => void) => {
  const contract = structuredClone(fare());
  edit(shape(contract.input));
  return contract;
};
const withOutput = (edit: (output: Shape) => void) => {
  const contract = structuredClone(fare());
  edit(shape(contract.output));
  return contract;
};

describe("a new version of a package's contracts", () => {
  it("keeps callers working when it only widens what it takes or adds what it gives", () => {
    const wider = withInput((input) => {
      input.field("month").maxLength = 10;
      input.properties.seat = { type: "string", maxLength: 10 };
      input.required = ["from"];
    });
    wider.output.properties = {
      ...(wider.output.properties as object),
      seen_at: { type: "string", maxLength: 40 },
    };
    expect(breakingChanges([fare()], [wider])).toEqual([]);
    expect(breakingChanges([fare()], [fare(), fare({ name: "dearest_fare" })])).toEqual([]);
  });

  it("is refused for each change that would break a caller, said in words", () => {
    const cases: [PackageContract[], string][] = [
      [[], "cheapest_fare is gone"],
      [[withInput((i) => (i.required = ["from", "to", "month"]))], "input.month became required"],
      [[withInput((i) => delete i.properties.direct)], "input.direct is gone"],
      [
        [
          withInput((i) => {
            i.properties.stops = { type: "integer" };
            i.required.push("stops");
          }),
        ],
        "input.stops is new and required",
      ],
      [[withInput((i) => (i.field("month").maxLength = 5))], "input.month takes less text"],
      [
        [withInput((i) => (i.properties.direct = { type: "string", maxLength: 3 }))],
        "input.direct changed kind",
      ],
      [[withOutput((o) => (o.required = ["fare"]))], "output.currency may be missing now"],
      [
        [withOutput((o) => delete o.properties.fare && (o.required = ["currency"]))],
        "output.fare is gone",
      ],
      [
        [withOutput((o) => o.field("currency").enum?.push("EUR"))],
        "output.currency may now be EUR",
      ],
      [[withOutput((o) => delete o.field("fare").minimum)], "output.fare may now be lower"],
    ];
    for (const [after, said] of cases)
      expect(breakingChanges([fare()], after).join("\n")).toContain(said);
  });
});
