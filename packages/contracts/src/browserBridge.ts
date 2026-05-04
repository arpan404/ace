import { Schema } from "effect";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);

export const BrowserBridgeOperation = Schema.Literals([
  "open_url",
  "list_tabs",
  "selected_tab",
  "dom_snapshot",
  "screenshot",
  "click",
  "fill",
  "back",
  "forward",
  "reload",
]);
export type BrowserBridgeOperation = typeof BrowserBridgeOperation.Type;

export const BrowserBridgeRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  threadId: ThreadId,
  operation: BrowserBridgeOperation,
  args: UnknownRecord,
});
export type BrowserBridgeRequest = typeof BrowserBridgeRequest.Type;

export const BrowserBridgeResolveInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  ok: Schema.Boolean,
  result: Schema.optional(UnknownRecord),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type BrowserBridgeResolveInput = typeof BrowserBridgeResolveInput.Type;

export const BrowserBridgeResolveResult = Schema.Struct({});
export type BrowserBridgeResolveResult = typeof BrowserBridgeResolveResult.Type;
