import { DeviceFailure } from "@ace/protocol/devices";
import { z } from "zod";

// This catalog is authored by ace. Error messages, hints and stacks from providers or helpers
// never become this catalog. Only intentional failures can cross the MCP boundary.
export const PublicToolCode = z.enum([
  "screen_disabled",
  "target_busy",
  "foreground_required",
  "focus_changed",
  "window_minimized",
  "window_offscreen",
  "secure_input_required",
  "clipboard_changed",
  "window_ambiguous",
  "key_unsupported",
  "modifier_unsupported",
  "no_key_window",
  "delivery_unconfirmed",
  "invalid_arguments",
  "invalid_html",
  "invalid_data",
  "execution_failed",
  "provider_unavailable",
  "provider_disabled",
  "model_unavailable",
  "account_unavailable",
  "admission_closed",
  "delegation_cancelled",
  "delegation_limit",
  "workspace_unavailable",
  "delegation_denied",
  "access_escalation_denied",
  "access_unavailable",
  "effort_unavailable",
  "stale_ref",
  "controller_changed",
  "human_controlled",
  "human_private",
  "browser_paused",
  "browser_closed",
  "backend_changed",
  "queue_full",
  "element_unavailable",
  "not_visible",
  "evaluate_approval_required",
  "page_text_limit",
  "approval_required",
  "denied",
  "read_only",
  "timeout",
  "invalid_origin",
  "delegation_required",
  "screenshot_required",
  "screenshot_failed",
  "target_gone",
  "permission_denied",
  "bounds",
  "not_supported",
  "busy",
  "sdk_missing",
  "tool_missing",
  "not_found",
  "not_booted",
  "command_failed",
  "lease_required",
  "limit",
  "machine_offline",
  "machine_unavailable",
  "machine_forbidden",
  "machine_disconnected",
  "tool_unavailable",
]);
export type PublicToolCode = z.infer<typeof PublicToolCode>;
const candidateIds = z
  .array(z.object({ windowId: z.number().int().min(0).max(0xffffffff) }))
  .max(128);
/** A field-level problem: where, and what the schema expects. Never the value that was sent. */
export const PublicIssue = z.strictObject({
  path: z.string().min(1).max(160),
  expected: z.string().min(1).max(240),
});
export type PublicIssue = z.infer<typeof PublicIssue>;
const issueList = z.array(PublicIssue).max(16);
const dispatchPhase = z.enum(["rejected-before-dispatch", "dispatched", "partial"]);
const catalog: Record<PublicToolCode, { message: string; hint: string }> = {
  screen_disabled: {
    message: "Computer use is disabled",
    hint: "The person turns computer use on in ace's Settings; stop and tell them.",
  },
  target_busy: {
    message: "App is controlled by another session",
    hint: "Another agent or the person holds this app. Work on another app, or call screen_open_app again once they release it.",
  },
  foreground_required: {
    message: "App requires foreground input",
    hint: "Call screen_request_foreground for this session. Do not repeat background input blindly.",
  },
  focus_changed: {
    message: "Input target focus changed",
    hint: "Inspect the target before retrying. Dispatched input may already have changed it.",
  },
  window_minimized: {
    message: "Target window is minimized",
    hint: "Call screen_list_windows and pick a visible window with screen_select_window; if it is the only one, ask the person to restore it.",
  },
  window_offscreen: {
    message: "Foreground pointer input cannot reach this off-display window",
    hint: "Use background semantic input or capture for this target.",
  },
  window_ambiguous: {
    message: "The helper cannot uniquely identify the selected window",
    hint: "Call screen_list_windows, then screen_open_app with windowId or screen_select_window for an existing session.",
  },
  key_unsupported: {
    message: "Unsupported key name",
    hint: "Pass a single key separately from modifiers. Letters, digits, punctuation, F1-F20, ArrowLeft/Right/Up/Down and Esc are accepted on macOS.",
  },
  modifier_unsupported: {
    message: "Unsupported keyboard modifier",
    hint: "Use command, shift, option, control, alt, meta or super.",
  },
  no_key_window: {
    message: "The selected window has no verified keyboard destination",
    hint: "Use screen_ui_act on a field, screen_menu or screen_open_url. Do not replay input into a different window.",
  },
  delivery_unconfirmed: {
    message: "Input was dispatched but its effect is unconfirmed",
    hint: "Inspect the destination before continuing. Do not retry automatically or assume foreground input is required.",
  },
  secure_input_required: {
    message: "Secure text needs session consent",
    hint: "Ask the human to enable secure input for this session.",
  },
  clipboard_changed: {
    message: "Clipboard changed during paste",
    hint: "The human's new clipboard was retained. Inspect the target before retrying.",
  },
  invalid_arguments: {
    message: "Invalid tool arguments",
    hint: "Nothing ran. Fix each field named in issues, keep the other arguments, and call again.",
  },
  invalid_html: {
    message: "The page has unsupported content and was not published",
    hint: "Fix each problem in issues, then call html_render again with the corrected page.",
  },
  invalid_data: {
    message: "Invalid tool or backend data",
    hint: "Retry once. If it fails again, tell the person and do the work another way.",
  },
  provider_unavailable: {
    message: "Provider CLI is unavailable",
    hint: "That provider's CLI is not installed here. Call models for the providers you can use and pick one; tell the person if this one is needed.",
  },
  provider_disabled: {
    message: "Provider is disabled",
    hint: "Call models for the enabled providers and pick one; only the person can enable this one.",
  },
  model_unavailable: {
    message: "Requested model is unavailable",
    hint: "Call models and pass a listed id, or omit model for the provider's default.",
  },
  account_unavailable: {
    message: "Provider account is unavailable",
    hint: "Retry with another provider from models, or without naming an account; the person fixes logins and quota.",
  },
  admission_closed: {
    message: "Daemon is not accepting agent work",
    hint: "ace is starting or shutting down. Retry the same call, with the same requestId, in a few seconds.",
  },
  delegation_cancelled: {
    message: "This agent is being stopped",
    hint: "Its parent or the person stopped it. Finish without starting new agents; a new message resumes it.",
  },
  delegation_limit: {
    message: "Delegation limit reached",
    hint: "Agents nest only a few levels deep, and ace runs a bounded number of threads at once. Do this work in this thread, or retry once other threads finish.",
  },
  workspace_unavailable: {
    message: "Workspace is unavailable for agent creation",
    hint: "Retry without workspace (this project's checkout), or call context with topics [changes] to check the branch first.",
  },
  delegation_denied: {
    message: "Child permissions exceed the parent permission ceiling",
    hint: "Retry with access inherit, or a mode no broader than yours.",
  },
  access_escalation_denied: {
    message: "The requested access is broader than the parent thread's",
    hint: "Use access inherit or one of the allowed modes listed in the error.",
  },
  access_unavailable: {
    message: "The target provider does not support the requested access mode",
    hint: "Use access inherit or one of the modes listed in the error.",
  },
  effort_unavailable: {
    message: "The selected model does not offer the requested effort",
    hint: "Use effort inherit or one of the levels listed in the error.",
  },
  execution_failed: {
    message: "Tool execution failed",
    hint: "The tool failed without a public reason. Do not send the identical call again: check the target's current state, change the request, or tell the person.",
  },
  stale_ref: {
    message: "Stale or unknown element ref",
    hint: "Call browser_snapshot, screen_ui_tree or device_ui_tree again and use a ref from it.",
  },
  controller_changed: {
    message: "Browser control changed while the action was queued",
    hint: "Take a fresh snapshot and retry after control is handed back.",
  },
  human_private: {
    message: "Browser is private while a human has control",
    hint: "Wait for explicit human handback. A disconnect does not restore agent access.",
  },
  human_controlled: {
    message: "Browser controlled by human",
    hint: "Wait for handback before input or closing.",
  },
  browser_paused: {
    message: "Browser backend paused",
    hint: "Ask the user to restore the browser backend or close it after handback.",
  },
  browser_closed: {
    message: "Browser closed",
    hint: "Call browser_open to open a new session.",
  },
  backend_changed: {
    message: "Browser backend changed during command",
    hint: "Take a fresh snapshot before retrying.",
  },
  queue_full: {
    message: "Browser command queue full",
    hint: "Wait for the pending commands to finish before retrying.",
  },
  element_unavailable: {
    message: "Browser element is detached or unavailable",
    hint: "Take a fresh snapshot and choose an editable or actionable element.",
  },
  not_visible: {
    message: "Browser element is not visible",
    hint: "Wait for visibility or choose an element in the latest snapshot.",
  },
  evaluate_approval_required: {
    message: "Browser evaluate was refused by the host policy",
    hint: "Read the page with a snapshot or find_text instead.",
  },
  page_text_limit: {
    message: "Browser text search exceeds the bounded page limit",
    hint: "Use a snapshot or a smaller page. This search reads at most 1024 nodes and 65536 text characters.",
  },
  approval_required: {
    message: "Browser origin was refused by the host policy",
    hint: "Use another origin.",
  },
  denied: {
    message: "Browser refused the request",
    hint: "Report the refusal; for uploads, pass regular files that are not being replaced.",
  },
  read_only: {
    message: "Read-only mode refuses agent navigation",
    hint: "This thread is read-only, so it cannot navigate. Tell the person if a page needs opening.",
  },
  timeout: {
    message: "Tool operation timed out",
    hint: "Inspect current page or device state and any pending approval before retrying.",
  },
  invalid_origin: {
    message: "Browser navigation requires an HTTP(S) URL without credentials",
    hint: "Use an absolute HTTP(S) URL without username or password.",
  },
  delegation_required: {
    message: "Screen delegation required",
    hint: "Call screen_open_app to take an app session. If a person took control, wait until they hand it back.",
  },
  screenshot_required: {
    message: "A fresh model screenshot is required for legacy coordinate input",
    hint: "Call screen_screenshot after takeover or capture geometry changes. Use pixels from that image.",
  },
  screenshot_failed: {
    message: "Screenshot encoding failed or exceeded the model limit",
    hint: "Install ffmpeg on the daemon host for large screenshots, or use semantic UI tools.",
  },
  target_gone: {
    message: "Native target is no longer available",
    hint: "Refresh the UI tree and select a current ref.",
  },
  permission_denied: {
    message: "Device or screen permission denied",
    hint: "Ask the user to check OS permissions and that devices are turned on.",
  },
  bounds: {
    message: "Input is outside the target bounds",
    hint: "Take a fresh screenshot or use semantic UI refs.",
  },
  not_supported: {
    message: "The installed device or helper does not support this operation",
    hint: "Use an advertised semantic action or check installed helper tools.",
  },
  busy: {
    message: "Device or screen helper is busy",
    hint: "Wait for the current operation or stop another live view.",
  },
  sdk_missing: {
    message: "Device SDK is unavailable",
    hint: "Ask the user to install and configure Xcode or Android SDK on the daemon host.",
  },
  tool_unavailable: {
    message: "This ace tool is not available to this thread",
    hint: "The name is wrong or its ace group is off here. Call context with topics [status] for the groups that are on, or guide for each task's tools; if a group is off, tell the person. Your own tools are unaffected.",
  },
  tool_missing: {
    message: "Required device tool is unavailable",
    hint: "Ask the user to install the required capture or input tools on the daemon host.",
  },
  not_found: {
    message: "Approved device was not found",
    hint: "Call device_list and use a listed deviceId.",
  },
  not_booted: { message: "Device is not booted", hint: "Call device_boot for an approved device." },
  command_failed: {
    message: "Device command failed",
    hint: "Check installed tools and device state before retrying.",
  },
  lease_required: {
    message: "Device controller lease required",
    hint: "Call device_start to take the device again. If a person is controlling it, wait until they hand it back.",
  },
  limit: {
    message: "Device operation exceeds its limit",
    hint: "Reduce the request or wait for current work to finish.",
  },
  machine_offline: {
    message: "That machine is offline",
    hint: "Do the work on this machine (omit machine), or call machines later. Only the person can wake it.",
  },
  machine_unavailable: {
    message: "That machine is not available to agents",
    hint: "Call machines for the machines you may use, or do the work on this machine.",
  },
  machine_forbidden: {
    message: "Not allowed on that machine",
    hint: "Its agent access or pairing is read-only, or this thread is read-only. Use a read-only tool there, or do the work on this machine.",
  },
  machine_disconnected: {
    message: "The connection to that machine dropped during the call",
    hint: "The action may or may not have run there. Check with a read-only tool before trying again.",
  },
};
export class PublicToolError extends Error {
  readonly code: PublicToolCode;
  readonly hint: string;
  readonly permission: DeviceFailure["permission"];
  readonly detail: string | undefined;
  readonly phase: z.infer<typeof dispatchPhase> | undefined;
  readonly candidates: z.infer<typeof candidateIds> | undefined;
  readonly issues: PublicIssue[] | undefined;
  constructor(
    code: PublicToolCode,
    permission?: DeviceFailure["permission"],
    phase?: unknown,
    candidates?: unknown,
    detail?: string,
    issues?: unknown,
  ) {
    const entry = catalog[code];
    super(entry.message);
    this.code = code;
    this.detail = detail
      ?.split("")
      .map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char))
      .join("")
      .replace(/[a-f0-9]{64}/gi, "[redacted]")
      .slice(0, 256);
    const parsedCandidates = candidateIds.safeParse(candidates);
    this.candidates =
      code === "window_ambiguous" && parsedCandidates.success ? parsedCandidates.data : undefined;
    const parsedIssues = issueList.safeParse(issues);
    this.issues = parsedIssues.success && parsedIssues.data.length ? parsedIssues.data : undefined;
    const parsedPhase = dispatchPhase.safeParse(phase);
    this.phase = parsedPhase.success ? parsedPhase.data : undefined;
    const parsed = DeviceFailure.shape.permission.safeParse(permission);
    this.permission = code === "permission_denied" && parsed.success ? parsed.data : undefined;
    this.hint =
      this.permission === "screenRecording"
        ? "Open System Settings > Privacy & Security > Screen Recording and enable Ace Screen Helper."
        : this.permission === "accessibility"
          ? "Open System Settings > Privacy & Security > Accessibility and enable Ace Screen Helper."
          : entry.hint;
  }
}
