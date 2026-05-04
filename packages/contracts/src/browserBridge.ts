import { Schema } from "effect";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);

export const BrowserBridgeOperation = Schema.Literals([
  "open_url",
  "navigate_tab_url",
  "list_tabs",
  "selected_tab",
  "get_tab",
  "create_tab",
  "new_tab",
  "close_tab",
  "dom_snapshot",
  "playwright_dom_snapshot",
  "dom_cua_get_visible_dom",
  "screenshot",
  "playwright_screenshot",
  "cua_get_visible_screenshot",
  "click",
  "cua_click",
  "cua_double_click",
  "cua_drag",
  "cua_keypress",
  "cua_move",
  "cua_scroll",
  "cua_type",
  "dom_cua_click",
  "dom_cua_double_click",
  "dom_cua_keypress",
  "dom_cua_scroll",
  "dom_cua_type",
  "fill",
  "playwright_locator_click",
  "playwright_locator_count",
  "playwright_locator_dblclick",
  "playwright_locator_fill",
  "playwright_locator_get_attribute",
  "playwright_locator_inner_text",
  "playwright_locator_is_enabled",
  "playwright_locator_is_visible",
  "playwright_locator_press",
  "playwright_locator_select_option",
  "playwright_locator_set_checked",
  "playwright_locator_text_content",
  "playwright_locator_wait_for",
  "playwright_wait_for_load_state",
  "playwright_wait_for_timeout",
  "playwright_wait_for_url",
  "tab_clipboard_read_text",
  "tab_clipboard_write_text",
  "tab_dev_logs",
  "set_viewport_size",
  "resize_browser",
  "get_viewport_size",
  "get_browser_zoom",
  "set_browser_zoom",
  "reset_browser_zoom",
  "zoom_browser",
  "name_session",
  "back",
  "navigate_tab_back",
  "forward",
  "navigate_tab_forward",
  "reload",
  "navigate_tab_reload",
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
