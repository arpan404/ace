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
  "invalid_image",
  "image_unavailable",
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
  "human_active",
  "human_private",
  "needs_person",
  "browser_paused",
  "browser_closed",
  "backend_changed",
  "queue_full",
  "tab_not_found",
  "tab_limit",
  "tab_crashed",
  "element_unavailable",
  "not_visible",
  "not_hittable",
  "covered",
  "viewport_mismatch",
  "unsaved_changes",
  "evaluate_approval_required",
  "storage_restricted",
  "evaluate_failed",
  "page_unreachable",
  "browser_restarted",
  "browser_unavailable",
  "recording_active",
  "recording_inactive",
  "recording_failed",
  "approval_required",
  "denied",
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
  "user_browser_unavailable",
  "machine_forbidden",
  "machine_disconnected",
  "transfers_off",
  "tool_unavailable",
  "thread_not_found",
  "thread_busy",
  "request_conflict",
  "handoff_unavailable",
  "approval_timeout",
  "page_timeout",
  "tool_timeout",
  "cancelled",
  "result_too_large",
  "calls_limit",
  "session_ended",
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
/** A log correlation id: opaque, short and never derived from the failure's text. */
export const ErrorId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
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
    hint: 'Call screen_open_app with mode:"foreground" for this app. Do not repeat background input blindly.',
  },
  focus_changed: {
    message: "Input target focus changed",
    hint: "Inspect the target before retrying. Dispatched input may already have changed it.",
  },
  window_minimized: {
    message: "Target window is minimized",
    hint: "Call screen_windows and pass a visible window's windowId to screen_open_app; if it is the only one, ask the person to restore it.",
  },
  window_offscreen: {
    message: "Foreground pointer input cannot reach this off-display window",
    hint: "Use background semantic input or capture for this target.",
  },
  window_ambiguous: {
    message: "The helper cannot uniquely identify the selected window",
    hint: "Call screen_windows, then screen_open_app with one of the windowIds.",
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
    hint: "Use screen_ui_act on a field or a menu path, or screen_open_app with url. Do not replay input into a different window.",
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
  invalid_image: {
    message: "The bytes are not a PNG, JPEG, WebP or GIF image and were not shown",
    hint: "Convert the image to PNG or JPEG (at most 8 MiB and 16,384 px per side), then call image_show again.",
  },
  image_unavailable: {
    message: "The image file could not be read",
    hint: "Pass the path of a regular file, not a symbolic link, at most 8 MiB. A relative path starts at your working directory.",
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
    hint: "The tool failed without a public reason. Do not send the identical call again: check the target's current state, change the request, or tell the person. errorId, when present, names the cause's entry in ace's log; give it to the person.",
  },
  stale_ref: {
    message: "Stale or unknown element ref",
    hint: "Read fresh refs (browser_snapshot, screen_ui_tree or sim_ui, matching the tool you used) and retry with a current ref.",
  },
  human_active: {
    message: "The person kept using this tab",
    hint: "They are working in it right now. Take a fresh snapshot, then retry in a moment or use another tab.",
  },
  human_private: {
    message: "The person keeps agents out of this tab",
    hint: "Use another tab (browser_tabs open for a new one), or ask the person to let agents into this one.",
  },
  needs_person: {
    message: "This page needs the person",
    hint: "The tab shows a certificate warning that only the person may proceed past. Tell them; they choose in ace's Browser panel. Navigate elsewhere or wait until they have.",
  },
  browser_paused: {
    message: "Browser backend paused",
    hint: "Call browser_open to resume the page; if it stays paused, tell the person.",
  },
  browser_closed: {
    message: "Browser closed",
    hint: "Call browser_open to open the browser again, then browser_snapshot.",
  },
  backend_changed: {
    message: "Browser backend changed during command",
    hint: "Call browser_snapshot for fresh refs before retrying.",
  },
  queue_full: {
    message: "Browser command queue full",
    hint: "Wait for the pending commands to finish before retrying.",
  },
  tab_not_found: {
    message: "Browser tab not found",
    hint: "Call browser_tabs (action list) for current tab ids; the tab may have been closed.",
  },
  tab_crashed: {
    message: "Browser tab crashed",
    hint: "The page crashed repeatedly and stays down. Reload it (browser_history direction reload) or navigate it to bring it back.",
  },
  tab_limit: {
    message: "Browser tab limit reached",
    hint: "Close tabs you no longer need with browser_tabs (action close, tabId), or reuse one of your tabs.",
  },
  element_unavailable: {
    message: "Browser element is detached or unavailable",
    hint: "Call browser_snapshot and choose an editable or actionable element.",
  },
  not_visible: {
    message: "Browser element is not visible",
    hint: 'Call browser_wait_for with the ref and state:"visible", or scroll with browser_act action:"scroll", then retry.',
  },
  not_hittable: {
    message: "Browser element cannot take the pointer",
    hint: "It is outside the page's viewport or kept moving. Scroll it into view or wait for the page to settle, then snapshot again and retry.",
  },
  covered: {
    message: "Another element covers the browser element",
    hint: "An overlay, banner, dialog or sticky header sits over it, so the click would land there. Dismiss or close what covers it, then snapshot again and retry.",
  },
  viewport_mismatch: {
    message: "The tab did not take the requested viewport size",
    hint: "detail gives the size the page lays out at; screenshots and clicks use that size. The person's browser panel may be holding the tab at its own size. For a one-off look at other widths, call browser_screenshot with sizes.",
  },
  unsaved_changes: {
    message: "The person has unsaved changes on this page",
    hint: "Leaving would discard what they entered. Dismiss the leave prompt to stay, ask the person, or open another tab with browser_tabs.",
  },
  evaluate_approval_required: {
    message: "Browser evaluate was refused by the host policy",
    hint: "Read the page with browser_snapshot or browser_find instead.",
  },
  storage_restricted: {
    message: "Agents can't read cookies or site storage in the person's own browser",
    hint: "In Use my Chrome, evaluate runs without document.cookie, localStorage, sessionStorage, indexedDB or cookieStore. Read the page's DOM instead, or ask the person to allow it in Settings › Computer use › Use my Chrome.",
  },
  evaluate_failed: {
    message: "The script threw, timed out or was refused",
    hint: "Scripts run up to 10 seconds. mode read-only refuses anything with side effects (writes, calls into page code, promises); use unrestricted for those, or read the page with a snapshot. Fix the expression before calling again.",
  },
  page_unreachable: {
    message: "The page could not be reached",
    hint: "detail names the network error. ERR_CONNECTION_REFUSED: nothing listens there; is the dev server running on that port? ERR_NAME_NOT_RESOLVED: check the host name. ERR_ABORTED: the response was a download or empty. Fix the cause, then navigate again.",
  },
  browser_restarted: {
    message: "The browser restarted",
    hint: "The tab reopened at its last address, but form input, scroll position and refs are gone. Take a fresh snapshot and redo any steps that were lost.",
  },
  browser_unavailable: {
    message: "ace's browser could not start",
    hint: "Its first start downloads Chrome for Testing, which needs the network. Retry once; if it still fails, tell the person to check ace's browser in Settings.",
  },
  recording_active: {
    message: "This browser is already recording",
    hint: "Call browser_settings with action record_stop to finish that recording before starting another.",
  },
  recording_inactive: {
    message: "Nothing is recording in this browser",
    hint: "Call browser_settings with action record_start first, then record_stop when done.",
  },
  recording_failed: {
    message: "The recording could not be saved",
    hint: "It captured no frames (a private tab records none) or could not be written. Start a new recording and keep the tab shared with agents.",
  },
  approval_required: {
    message: "Browser origin was refused by the host policy",
    hint: "ace's host does not allow agents on this site. Local addresses (localhost, 127.0.0.1) are always allowed. Do not retry the same address: use an allowed one, or ask the person to allow this site.",
  },
  denied: {
    message: "Browser refused the request",
    hint: "Report the refusal; for uploads, pass regular files that are not being replaced.",
  },
  timeout: {
    message: "Tool operation timed out",
    hint: "Check current state (browser_open, sim_list or screen_screenshot) before retrying; pass a longer timeout for slow pages.",
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
    hint: "Call screen_screenshot again; control changed during the capture.",
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
    hint: "The name is wrong or its ace group is off here. Call tools_find with what you want to do, or context with topics [status] for the groups that are off; if one is, tell the person. Your own tools are unaffected.",
  },
  tool_missing: {
    message: "Required device tool is unavailable",
    hint: "Ask the user to install the required capture or input tools on the daemon host.",
  },
  not_found: {
    message: "Simulator or emulator was not found",
    hint: "Call sim_list for current simIds and retry with one of them.",
  },
  not_booted: {
    message: "Simulator is not booted",
    hint: "Call sim_start with this simId (boot defaults to true).",
  },
  command_failed: {
    message: "Device command failed",
    hint: "Check installed tools and device state before retrying.",
  },
  lease_required: {
    message: "This thread does not hold the simulator",
    hint: "Call sim_start for this simId. If a person is using it, wait until they hand it back.",
  },
  limit: {
    message: "The request exceeds a size or count limit",
    hint: "Ask for less at once (fewer or smaller files, a smaller capture, fewer items), or wait for current work to finish.",
  },
  machine_offline: {
    message: "That machine is offline",
    hint: "Do the work on this machine (omit machine), or call machines later. Only the person can wake it.",
  },
  user_browser_unavailable: {
    message: "The person's own browser is not connected to ace",
    hint: "Ask the person to turn on Use my Chrome (Settings › Computer use) and keep Chrome open with the ace extension, or omit browser to use ace's browser. It is only available on this machine.",
  },
  machine_unavailable: {
    message: "That machine is not available to agents",
    hint: "Call machines for the machines you may use, or do the work on this machine.",
  },
  transfers_off: {
    message: "Agents can't move work to other machines here",
    hint: "The person turns on \"Agents can move projects and threads to other machines\" in Settings › Machines; stop and tell them, or keep working on this machine.",
  },
  machine_forbidden: {
    message: "Not allowed on that machine",
    hint: "Its agent access or pairing is read-only, or this thread is read-only. Use a read-only tool there, or do the work on this machine.",
  },
  thread_not_found: {
    message: "That thread or task no longer exists",
    hint: "It was deleted or never existed. Call threads_find, or agents_status for your children, for current threadIds.",
  },
  thread_busy: {
    message: "The thread is changing state",
    hint: "It is being created, recovered, switched or moved right now. Retry the same call, with the same requestId, in a few seconds.",
  },
  request_conflict: {
    message: "This requestId was already used for a different request",
    hint: "A requestId names one request. Reuse it only to repeat that exact call; for a new request, pass a new requestId.",
  },
  handoff_unavailable: {
    message: "That history is not part of this thread's handoff",
    hint: "handoff_read reads only the threads a handoff cites, up to the point it was handed over. Use the sourceThreadId the handoff names, or thread_read for other threads.",
  },
  approval_timeout: {
    message: "The person did not allow this site in time",
    hint: "ace asked the person to let agents on this site and got no answer. Do not retry it blindly: tell them which site you need and why; once they allow it, call again. Local addresses (localhost, 127.0.0.1) never need approval.",
  },
  page_timeout: {
    message: "The page did not load within timeout",
    hint: "It may still be loading. browser_snapshot shows where it got; for a dev server, check it responds. Then call browser_open again with a larger timeout (up to the wait limit).",
  },
  tool_timeout: {
    message: "The call ran past this tool's time limit and was stopped",
    hint: "Anything it changed may be partly done: check the target's current state before calling again, and ask for less at once (a smaller scope or a shorter wait).",
  },
  cancelled: {
    message: "The call was cancelled before it finished",
    hint: "The client, the person or a stop request cancelled it. Call again only if the work is still wanted; what it changed may be partly done.",
  },
  result_too_large: {
    message: "The result was too large to return",
    hint: "Nothing is lost; ask for less: a smaller limit, a narrower scope (ref, depth, filter) or a byte range, then call again.",
  },
  calls_limit: {
    message: "Too many ace calls are running at once",
    hint: "Let running calls (waits, long browser waits) finish, then call again; do not start more in parallel.",
  },
  session_ended: {
    message: "This ace session has ended",
    hint: "The connection's lease is over and no ace tool works in it. Finish without ace tools; a new turn gets a new session.",
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
  /** Names the daemon log entry holding the private cause, for a person to look up. */
  readonly errorId: string | undefined;
  constructor(
    code: PublicToolCode,
    permission?: DeviceFailure["permission"],
    phase?: unknown,
    candidates?: unknown,
    detail?: string,
    issues?: unknown,
    errorId?: string,
  ) {
    const entry = catalog[code];
    super(entry.message);
    this.code = code;
    this.errorId = ErrorId.safeParse(errorId).success ? errorId : undefined;
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
