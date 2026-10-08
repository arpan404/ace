import { DeviceFailure } from "@ace/protocol/devices";
import { z } from "zod";

// This catalog is authored by ace. Error messages, hints and stacks from providers or helpers
// never become this catalog. Only intentional failures can cross the MCP boundary.
export const PublicToolCode = z.enum([
  "screen_disabled",
  "screen_approval_denied",
  "screen_approval_timeout",
  "screen_read_only",
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
]);
export type PublicToolCode = z.infer<typeof PublicToolCode>;
const candidateIds = z
  .array(z.object({ windowId: z.number().int().min(0).max(0xffffffff) }))
  .max(128);
const dispatchPhase = z.enum(["rejected-before-dispatch", "dispatched", "partial"]);
const catalog: Record<PublicToolCode, { message: string; hint: string }> = {
  screen_approval_denied: {
    message: "Screen access approval denied",
    hint: "Ask the person to approve this app or screen mode before retrying.",
  },
  screen_approval_timeout: {
    message: "Screen access approval expired",
    hint: "Request screen access again when the person is available.",
  },
  screen_read_only: {
    message: "Screen access is read-only",
    hint: "Ask the person to grant control before sending screen input.",
  },
  screen_disabled: {
    message: "Computer use is disabled",
    hint: "A human must enable screen access before an agent can use apps.",
  },
  target_busy: {
    message: "App is controlled by another session",
    hint: "Inspect screen sessions and ask the holder to hand back control.",
  },
  foreground_required: {
    message: "App requires foreground approval",
    hint: "Call screen_request_foreground with a reason. Do not repeat background input blindly.",
  },
  focus_changed: {
    message: "Input target focus changed",
    hint: "Inspect the target before retrying. Dispatched input may already have changed it.",
  },
  window_minimized: {
    message: "Target window is minimized",
    hint: "Ask the human to restore the window.",
  },
  window_offscreen: {
    message: "Foreground pointer input cannot reach this off-display window",
    hint: "Use background semantic input or capture for this target.",
  },
  window_ambiguous: {
    message: "The helper cannot uniquely identify the selected window",
    hint: "Refresh window candidates and select an exact window ID.",
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
    hint: "Use ui.act on a field, or the helper's menu.press/open.url operations. Do not replay input into a different window.",
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
  window_ambiguous: {
    message: "App window identity is ambiguous",
    hint: "Call screen_list_windows, then screen_open_app with windowId or screen_select_window for an existing session. No input was dispatched when phase is rejected-before-dispatch.",
  },
  key_unsupported: {
    message: "Named key is unsupported",
    hint: "Choose a key from screen_key's enum. Use screen_type for Unicode text.",
  },
  modifier_unsupported: {
    message: "Key modifier is unsupported",
    hint: "Use command, option, shift or control, or the advertised aliases alt, meta and super.",
  },
  no_key_window: {
    message: "Selected window has no verified keyboard destination",
    hint: "Inspect screen_ui_tree and focus an editable field with screen_ui_act, or use screen_menu or screen_open_url.",
  },
  delivery_unconfirmed: {
    message: "Input was dispatched but delivery is unconfirmed",
    hint: "Inspect screen_ui_tree or screen_screenshot before retrying. Repeating text or clicks can duplicate the action.",
  },
  invalid_arguments: {
    message: "Invalid tool arguments",
    hint: "Check the advertised tool schema and required fields. Choose exactly one browser wait condition.",
  },
  invalid_data: {
    message: "Invalid tool or backend data",
    hint: "Retry once. If the error persists, report it to the user.",
  },
  provider_unavailable: {
    message: "Provider CLI is unavailable",
    hint: "Install the provider CLI on the daemon host, set its binary path in provider settings, and check its login.",
  },
  provider_disabled: {
    message: "Provider is disabled",
    hint: "Enable this provider and account in provider settings before delegating.",
  },
  model_unavailable: {
    message: "Requested model is unavailable",
    hint: "Refresh the selected provider account's model catalog and choose an available model.",
  },
  account_unavailable: {
    message: "Provider account is unavailable",
    hint: "Check the selected account, its CLI login and quota, or choose another account.",
  },
  admission_closed: {
    message: "Daemon is not accepting agent work",
    hint: "Wait for daemon startup or maintenance to finish before retrying.",
  },
  delegation_cancelled: {
    message: "Delegation was stopped",
    hint: "Send a new message or explicitly resume the stopped parent thread before delegating again.",
  },
  delegation_limit: {
    message: "Delegation capacity or budget is exhausted",
    hint: "Wait for active children to finish or start a new root thread within the host limits.",
  },
  workspace_unavailable: {
    message: "Workspace is unavailable for agent creation",
    hint: "Check that the workspace exists and finish any workspace or worktree change before retrying.",
  },
  delegation_denied: {
    message: "Child permissions exceed the parent permission ceiling",
    hint: "Choose a permission mode allowed by the parent thread.",
  },
  execution_failed: {
    message: "Tool execution failed",
    hint: "Retry once or report the failure to the user.",
  },
  stale_ref: {
    message: "Stale or unknown element ref",
    hint: "Refresh ace_browser_snapshot, screen_ui_tree or device_ui_tree for the affected tool and use a current ref.",
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
    hint: "Call ace_browser_open to open a new session.",
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
    message: "Browser evaluate requires approval",
    hint: "Ask the user to approve evaluation.",
  },
  page_text_limit: {
    message: "Browser text search exceeds the bounded page limit",
    hint: "Use a snapshot or a smaller page. This search reads at most 1024 nodes and 65536 text characters.",
  },
  approval_required: {
    message: "Browser origin requires approval",
    hint: "Wait for the user to decide the origin approval.",
  },
  denied: {
    message: "Browser origin approval denied",
    hint: "Report the denial and use an approved origin.",
  },
  read_only: {
    message: "Read-only mode refuses agent navigation",
    hint: "Ask the user to change the permission mode before navigating.",
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
    hint: "Ask the user to enable screen access, approve an app and delegate its screen session to this agent. After takeover, wait for delegation again.",
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
    hint: "Ask the user to check OS permissions, device approval and delegation.",
  },
  bounds: {
    message: "Input is outside the approved target bounds",
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
  tool_missing: {
    message: "Required device tool is unavailable",
    hint: "Ask the user to install the required capture or input tools on the daemon host.",
  },
  not_found: {
    message: "Approved device was not found",
    hint: "Refresh device_list and ask the user to check the device.",
  },
  not_booted: { message: "Device is not booted", hint: "Call device_boot for an approved device." },
  command_failed: {
    message: "Device command failed",
    hint: "Check installed tools and device state before retrying.",
  },
  lease_required: {
    message: "Device controller lease required",
    hint: "Ask the user to delegate the device controller again after expiry or takeover.",
  },
  limit: {
    message: "Device operation exceeds its limit",
    hint: "Reduce the request or wait for current work to finish.",
  },
};
export class PublicToolError extends Error {
  readonly code: PublicToolCode;
  readonly hint: string;
  readonly permission: DeviceFailure["permission"];
  readonly detail: string | undefined;
  readonly phase: z.infer<typeof dispatchPhase> | undefined;
  readonly candidates: z.infer<typeof candidateIds> | undefined;
  constructor(
    code: PublicToolCode,
    permission?: DeviceFailure["permission"],
    phase?: unknown,
    candidates?: unknown,
    detail?: string,
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
