import type { Frame } from "@ace/engine-api";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { expect, it } from "vitest";
import { frameEnvelopeError } from "./frame-envelope.ts";

const frame: Frame = { seq: 0, t: 0, dir: "recv", channel: "stdio", data: { type: "x" } };
const payload = new ProviderPayload('{"type":"x"}');

it.each<[string, Frame]>([
  ["a plain frame", frame],
  ["a frame with its admission certificate", { ...frame, data: payload.data, payload }],
  ["a frame with a usage account", { ...frame, usageAccount: { id: "acct", billingMode: "api" } }],
  ["a frame with no data", { ...frame, seq: 9, t: 1.5, dir: "note", data: undefined }],
])("accepts %s", (_name, input) => {
  expect(frameEnvelopeError(input)).toBeUndefined();
});

const bad = (fields: Record<string, unknown>) => ({ ...frame, ...fields }) as unknown as Frame;
it.each<[string, Frame, string]>([
  ["a negative sequence", bad({ seq: -1 }), "seq"],
  ["a fractional sequence", bad({ seq: 1.5 }), "seq"],
  ["an unsafe sequence", bad({ seq: 2 ** 53 }), "seq"],
  ["a negative time", bad({ t: -1 }), "t"],
  ["a time that is not finite", bad({ t: Number.NaN }), "t"],
  ["an unknown direction", bad({ dir: "sideways" }), "dir"],
  ["a missing channel", bad({ channel: undefined }), "channel"],
  ["a certificate ace did not make", bad({ payload: { data: frame.data, bytes: 3 } }), "payload"],
  ["an empty account id", bad({ usageAccount: { id: "", billingMode: "api" } }), "usageAccount.id"],
  [
    "an unknown billing mode",
    bad({ usageAccount: { id: "a", billingMode: "free" } }),
    "usageAccount.billingMode",
  ],
])("rejects %s", (_name, input, field) => {
  expect(frameEnvelopeError(input)).toBe(field);
});
