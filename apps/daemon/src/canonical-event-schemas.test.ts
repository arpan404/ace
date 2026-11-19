import { Event } from "@ace/protocol";
import { expect, test } from "vitest";
import { z } from "zod";
import { canonicalEvent, canonicaliser } from "./canonical-event.ts";

/*
 * Schemas change. Whatever an envelope or a payload variant comes to hold, the canonicaliser
 * must give what the schema's own parse gives (the same JSON, the same keys present as
 * undefined, a rejection exactly where it rejects), and must never fail to build: a shape it
 * can't plan goes to the schema's parse. These run it on synthetic schemas next to Zod.
 */

type Outcome = { ok: true; json: string; value: unknown } | { ok: false };
function outcome(run: () => unknown): Outcome {
  try {
    const value = run();
    return { ok: true, json: JSON.stringify(value), value };
  } catch {
    return { ok: false };
  }
}
function expectSame(expected: Outcome, actual: Outcome, input: unknown): void {
  const label = JSON.stringify(input) ?? String(input);
  expect(actual.ok, label).toBe(expected.ok);
  if (!actual.ok || !expected.ok) return;
  expect(actual.json, label).toBe(expected.json);
  expect(actual.value, label).toStrictEqual(expected.value);
}
/** Runs `schema.parse` and the canonicaliser on each input, built fresh for each by `make`. */
function expectSameFor(schema: z.ZodType, inputs: unknown[]): void {
  const fast = canonicaliser(schema);
  for (const input of inputs)
    expectSame(
      outcome(() => schema.parse(input)),
      outcome(() => fast.canonical(input)),
      input,
    );
}
const envelope = (payload: z.ZodType) => z.object({ seq: z.number().int(), payload });
const wrap = (payload: unknown) => ({ seq: 1, payload });
const valueVariant = (value: z.ZodType) =>
  envelope(z.discriminatedUnion("type", [z.object({ type: z.literal("v"), value })]));

const numbers: unknown[] = [
  0,
  1,
  -1,
  1.5,
  -0.5,
  2 ** 31,
  2 ** 32,
  2 ** 40,
  2 ** 53,
  3.5e38,
  3.5e39,
  Number.NaN,
  Infinity,
  "1",
  null,
];

test("number schemas that are checks themselves (z.int() and the other formats) parse as Zod does", () => {
  const formats = [z.int(), z.int().nonnegative(), z.int32(), z.uint32(), z.float32(), z.float64()];
  for (const format of formats) {
    const schema = valueVariant(format);
    expectSameFor(
      schema,
      numbers.map((value) => wrap({ type: "v", value })),
    );
  }
  // The method form of the same rule is planned, so the plan's own checks run there.
  const method = valueVariant(z.number().int().nonnegative());
  expect(canonicaliser(method).planned.has("v")).toBe(true);
  expectSameFor(
    method,
    numbers.map((value) => wrap({ type: "v", value })),
  );
});

test("string formats are not mistaken for plain strings", () => {
  const values = ["a@b.co", "not an email", "", 1];
  for (const format of [z.email(), z.uuid(), z.url()])
    expectSameFor(
      valueVariant(format),
      values.map((value) => wrap({ type: "v", value })),
    );
});

test("variants a plan can't cover build without throwing and parse as Zod does", () => {
  const variants = [
    z.object({ type: z.literal("flat"), text: z.string() }),
    z.object({ type: z.literal("piped"), text: z.string() }).transform((value) => ({ ...value })),
    z.object({ type: z.enum(["enum-a", "enum-b"]), text: z.string() }),
    z.object({ type: z.literal("defaulted"), count: z.number().default(3) }),
    z.object({ type: z.literal("nested"), inner: z.object({ text: z.string() }) }),
    z
      .object({ type: z.literal("refined"), text: z.string() })
      .refine((value) => value.text !== "x"),
    z.object({ type: z.literal("loose"), text: z.string() }).loose(),
    z.object({ type: z.literal("union"), value: z.union([z.string(), z.number()]) }),
  ] as const;
  const schema = envelope(z.discriminatedUnion("type", [...variants]));
  const fast = canonicaliser(schema);
  expect([...fast.planned]).toEqual(["flat"]);
  const types = ["flat", "piped", "enum-a", "enum-b", "defaulted", "nested", "refined"];
  const payloads: Record<string, unknown>[] = types.flatMap((type) => [
    { type, text: "t" },
    { type, text: "x", extra: 1 },
    { type, count: 5 },
    { type },
    { type, inner: { text: "t" } },
  ]);
  payloads.push({ type: "loose", text: "t", kept: true }, { type: "union", value: 2 });
  expectSameFor(schema, payloads.map(wrap));
});

test("envelopes a plan can't cover parse as Zod does", () => {
  const union = z.discriminatedUnion("type", [
    z.object({ type: z.literal("v"), text: z.string() }),
  ]);
  const envelopes = [
    z.object({ payload: union, seq: z.number() }),
    z.object({ seq: z.number().default(9), payload: union }),
    z.object({ seq: z.number(), payload: z.object({ type: z.string() }) }),
    z.object({ seq: z.number(), payload: union }).transform((value) => value),
    z.object({ seq: z.number(), payload: union }).strict(),
  ];
  for (const schema of envelopes)
    expectSameFor(schema, [
      wrap({ type: "v", text: "t" }),
      { payload: { type: "v", text: "t" } },
      { ...wrap({ type: "v", text: "t" }), extra: 1 },
    ]);
});

test("string lengths count code points, as Zod does, at both bounds", () => {
  const schema = valueVariant(z.string().min(2).max(3));
  expect(canonicaliser(schema).planned.has("v")).toBe(true);
  const strings = [
    "",
    "a",
    "ab",
    "abc",
    "abcd",
    "😀",
    "😀a",
    "a😀b",
    "😀😀",
    "😀😀😀",
    "😀😀a",
    "😀😀😀😀",
    "\ud800",
    "\udc00\ud800",
    "\ud800\ud800",
    "𐀀\ud800",
    "a\ud800",
    "é",
    "👨‍👩‍👧",
  ];
  expectSameFor(
    schema,
    strings.map((value) => wrap({ type: "v", value })),
  );
  expectSameFor(
    valueVariant(z.string().min(1)),
    ["", "😀", "\ud800"].map((value) => wrap({ type: "v", value })),
  );
});

test("an enum with numeric reverse names accepts what Zod accepts", () => {
  const schema = valueVariant(z.enum({ 0: "A", A: 0 }));
  expectSameFor(
    schema,
    ["A", 0, "0", 1, null].map((value) => wrap({ type: "v", value })),
  );
});

/** Event.parse and canonicalEvent, each on its own input from `make`, give the same. */
function expectSameEvents(make: () => unknown): void {
  const input = make();
  expectSame(
    outcome(() => Event.parse(input)),
    outcome(() => canonicalEvent(make())),
    input,
  );
}
const delta = () => ({
  type: "item.delta",
  itemId: "item-1",
  agentId: "agent-1",
  field: "text",
  append: "hi",
});
const head = () => ({ seq: 1, id: "event-1", at: 1, threadId: "thread-1" });

const counting = () => {
  let reads = 0;
  return () => `item-${++reads}`;
};

test("inputs with getters, proxies or inherited fields come out as Event.parse gives them", () => {
  expectSameEvents(() => {
    const next = counting();
    return {
      ...head(),
      get payload() {
        return { ...delta(), itemId: next() };
      },
    };
  });
  expectSameEvents(() => {
    const next = counting();
    return {
      ...head(),
      payload: {
        ...delta(),
        get itemId() {
          return next();
        },
      },
    };
  });
  expectSameEvents(() => {
    const next = counting();
    return {
      get seq() {
        return Number(next().slice(5));
      },
      id: "event-1",
      at: 1,
      threadId: "thread-1",
      payload: delta(),
    };
  });
  // One counter behind two fields: what each gets depends on which is read first.
  expectSameEvents(() => {
    let reads = 0;
    return {
      get seq() {
        return ++reads;
      },
      id: "event-1",
      at: 1,
      threadId: "thread-1",
      get payload() {
        return { ...delta(), itemId: `item-${++reads}` };
      },
    };
  });
  expectSameEvents(() => {
    let reads = 0;
    return new Proxy(
      { ...head(), payload: delta() },
      {
        get: (target, key) =>
          key === "seq"
            ? ++reads
            : key === "payload"
              ? { ...target.payload, itemId: `item-${++reads}` }
              : Reflect.get(target, key),
      },
    );
  });
  // Inherited data and inherited getters.
  expectSameEvents(() => ({ ...head(), payload: Object.assign(Object.create(delta()), {}) }));
  expectSameEvents(() => Object.assign(Object.create({ payload: delta() }), head()));
  expectSameEvents(() => {
    const next = counting();
    const proto = {
      get itemId() {
        return next();
      },
    };
    const { itemId: _, ...rest } = delta();
    return { ...head(), payload: Object.assign(Object.create(proto), rest) };
  });
  // Proxies, whose traps are code too.
  expectSameEvents(() => {
    const next = counting();
    return new Proxy(
      { ...head(), payload: delta() },
      {
        get: (target, key) =>
          key === "payload" ? { ...target.payload, itemId: next() } : Reflect.get(target, key),
      },
    );
  });
  expectSameEvents(() => {
    const next = counting();
    return {
      ...head(),
      payload: new Proxy(delta(), {
        get: (target, key) => (key === "itemId" ? next() : Reflect.get(target, key)),
      }),
    };
  });
  // A setter alone runs nothing on a read: the field reads as undefined in both.
  expectSameEvents(() => ({
    ...head(),
    payload: {
      ...delta(),
      set itemId(_value: string) {},
    },
  }));
});
