import { DeviceFailure } from "@ace/protocol/devices";
import { z } from "zod";

// This catalog is authored by ace. Error messages, hints and stacks from providers or helpers
// never become this catalog. Only intentional failures can cross the MCP boundary.
export const PublicToolCode = z.enum([
  "invalid_arguments",
  "invalid_data",
  "execution_failed",
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
const catalog: Record<PublicToolCode, { message: string; hint: string }> = {
  invalid_arguments: {
    message: "Invalid tool arguments",
    hint: "Check the advertised tool schema and required fields. Choose exactly one browser wait condition.",
  },
  invalid_data: {
    message: "Invalid tool or backend data",
    hint: "Retry once. If the error persists, report it to the user.",
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
  constructor(code: PublicToolCode, permission?: DeviceFailure["permission"]) {
    const detail = catalog[code];
    super(detail.message);
    this.code = code;
    const parsed = DeviceFailure.shape.permission.safeParse(permission);
    this.permission = code === "permission_denied" && parsed.success ? parsed.data : undefined;
    this.hint =
      this.permission === "screenRecording"
        ? "Open System Settings > Privacy & Security > Screen Recording and enable Ace Screen Helper."
        : this.permission === "accessibility"
          ? "Open System Settings > Privacy & Security > Accessibility and enable Ace Screen Helper."
          : detail.hint;
  }
}
