import { describe, expect, it } from "vitest";
import { TriggerVariables } from "@ace/protocol";
import { webhookBodyLimits, webhookVariables } from "./webhook-body.ts";

const read = (body: unknown) =>
  webhookVariables(
    new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
    "evt_1",
  );
const fields = (count: number) =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${i}`, i]));
const nested = (depth: number): unknown => (depth === 1 ? { leaf: 1 } : { a: nested(depth - 1) });

describe("webhook body variables", () => {
  it("makes each leaf a body variable, with the delivery id beside them", () => {
    const result = read({
      deploy: { env: "prod", ok: true, attempts: 3, note: null },
      tags: ["a", "b"],
    });
    expect(result).toEqual({
      ok: true,
      variables: {
        "webhook.id": "evt_1",
        "body.deploy.env": "prod",
        "body.deploy.ok": "true",
        "body.deploy.attempts": "3",
        "body.deploy.note": "null",
        "body.tags.0": "a",
        "body.tags.1": "b",
      },
    });
    if (result.ok) expect(TriggerVariables.safeParse(result.variables).success).toBe(true);
  });

  it("accepts an empty object", () => {
    expect(read({})).toEqual({ ok: true, variables: { "webhook.id": "evt_1" } });
  });

  it("refuses bodies that aren't one JSON object", () => {
    for (const body of ["", "not json", "[1,2]", '"text"', "42", "null"])
      expect(read(body)).toMatchObject({ ok: false });
  });

  it("refuses bytes that aren't UTF-8", () => {
    expect(webhookVariables(new Uint8Array([0x7b, 0xff, 0x7d]), "evt_1")).toMatchObject({
      ok: false,
    });
  });

  it("refuses a body over the byte limit instead of reading part of it", () => {
    const body = { text: "x".repeat(webhookBodyLimits.bytes) };
    expect(read(body)).toMatchObject({ ok: false, error: "too_large" });
  });

  it("refuses nesting past the depth limit", () => {
    expect(read(nested(webhookBodyLimits.depth))).toMatchObject({ ok: true });
    expect(read(nested(webhookBodyLimits.depth + 1))).toMatchObject({ ok: false });
  });

  it("refuses more leaves than the prompt can hold, rather than dropping some", () => {
    expect(read(fields(webhookBodyLimits.leaves))).toMatchObject({ ok: true });
    expect(read(fields(webhookBodyLimits.leaves + 1))).toMatchObject({ ok: false });
  });

  it("refuses more values than the node limit, even when few are leaves", () => {
    const empties = Object.fromEntries(
      Array.from({ length: webhookBodyLimits.nodes }, (_, i) => [`e${i}`, {}]),
    );
    expect(read(empties)).toMatchObject({ ok: false });
  });

  it("refuses a value longer than a variable can hold, rather than clipping it", () => {
    expect(read({ text: "x".repeat(webhookBodyLimits.valueLength) })).toMatchObject({ ok: true });
    expect(read({ text: "x".repeat(webhookBodyLimits.valueLength + 1) })).toMatchObject({
      ok: false,
    });
  });

  it("refuses keys a prompt variable can't name", () => {
    for (const key of ["pull-request", "", "a.b", "émoji"])
      expect(read({ [key]: 1 })).toMatchObject({ ok: false });
  });

  it("refuses a path longer than a variable name can be", () => {
    expect(read({ ["k".repeat(130)]: 1 })).toMatchObject({ ok: false });
  });
});
