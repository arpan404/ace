import type { AppDevice, DeviceInput, DeviceState } from "@ace/protocol";

/** One simulator or emulator as the devices list shows it. */
export interface DeviceRow {
  id: string;
  name: string;
  platform: AppDevice["platform"];
  /** "iOS 18.4 · Running", "Android 15 · Off". */
  detail: string;
  running: boolean;
  /** Its screen is streaming. */
  live: boolean;
}

const stateWords: Record<AppDevice["state"], string> = {
  booted: "Running",
  shutdown: "Off",
  offline: "Offline",
  unauthorized: "Not authorized",
};

/** iOS first, then Android; running devices before the rest; then by name. */
export function deviceRows(
  devices: readonly AppDevice[],
  states: readonly DeviceState[],
): DeviceRow[] {
  const byId = new Map(states.map((state) => [state.device.id, state]));
  // A session's state is newer than the inventory (a boot since the list was read), and a
  // device the daemon has a session for but no longer lists still shows from its state.
  const all = new Map(devices.map((device) => [device.id, device]));
  for (const state of states) all.set(state.device.id, state.device);
  return [...all.values()]
    .map((device): DeviceRow => {
      const state = byId.get(device.id);
      return {
        id: device.id,
        name: device.name,
        platform: device.platform,
        detail: [device.runtime, stateWords[device.state]].filter(Boolean).join(" · "),
        running: device.state === "booted",
        live: state?.lifecycle === "live",
      };
    })
    .toSorted(
      (a, b) =>
        b.platform.localeCompare(a.platform) ||
        Number(b.running) - Number(a.running) ||
        a.name.localeCompare(b.name),
    );
}

/** What a person can do with the selected device from this thread, and how to say where it is. */
export interface DeviceControls {
  /** Approved for this thread: its agents may see and use it. */
  approvedHere: boolean;
  /** Approved for another thread; approving here moves it. */
  approvedElsewhere: boolean;
  running: boolean;
  live: boolean;
  busy: boolean;
  /** Who drives input now. */
  controller: DeviceState["controller"];
  /** You hold an unexpired control lease. */
  inControl: boolean;
  /** Milliseconds left on your lease; 0 when you don't hold one. */
  leaseLeftMs: number;
  /** One line: "Live · You're in control", "Off", "Live · The agent is in control". */
  status: string;
  error: DeviceProblem | undefined;
}

/** A refusal or failure as a person reads it; `permission` names a missing macOS permission. */
export interface DeviceProblem {
  message: string;
  hint: string;
  permission?: "screenRecording" | "accessibility" | undefined;
}

export function deviceProblem(failure: DeviceProblem & { code: string }): DeviceProblem {
  if (failure.permission)
    return { message: failure.message, hint: failure.hint, permission: failure.permission };
  const plain: Record<string, DeviceProblem> = {
    command_failed: {
      message: "The device action didn't finish.",
      hint: "Check that the device is running, then try again.",
    },
    tool_missing: {
      message: "A device tool is missing on this machine.",
      hint: "Install the device and recording tools, then try again.",
    },
    sdk_missing: {
      message: "The device software isn't installed.",
      hint: "Install Xcode for iOS or the Android SDK, then reconnect.",
    },
    invalid_data: {
      message: "The device returned an unreadable response.",
      hint: "Restart its live view and try again.",
    },
  };
  return plain[failure.code] ?? { message: failure.message, hint: failure.hint };
}

export function deviceControls(
  device: AppDevice,
  state: DeviceState | undefined,
  threadId: string,
  now: number,
): DeviceControls {
  const controller = state?.controller ?? "none";
  const leaseLeftMs = controller === "human" ? Math.max(0, (state?.leaseExpiresAt ?? 0) - now) : 0;
  const inControl = leaseLeftMs > 0;
  const lifecycle = state?.lifecycle ?? "idle";
  const live = lifecycle === "live";
  const busy = lifecycle === "starting" || lifecycle === "stopping";
  const running = device.state === "booted";
  const where =
    lifecycle === "starting"
      ? "Starting"
      : lifecycle === "stopping"
        ? "Stopping"
        : lifecycle === "failed"
          ? "Stream failed"
          : live
            ? "Live"
            : running
              ? "Running"
              : stateWords[device.state];
  const who = inControl
    ? "You're in control"
    : controller === "agent"
      ? "The agent is in control"
      : controller === "human"
        ? "Your control ended"
        : undefined;
  return {
    approvedHere: state?.threadId === threadId,
    approvedElsewhere: state?.threadId !== undefined && state.threadId !== threadId,
    running,
    live,
    busy,
    controller,
    inControl,
    leaseLeftMs,
    status: who ? `${where} · ${who}` : where,
    error: state?.error && deviceProblem(state.error),
  };
}

/** A frame's size in device points: input uses points, frames carry encoded pixels. */
export interface FrameSize {
  width: number;
  height: number;
  scale?: number | undefined;
}

/** A coordinate rounded onto the screen: 0 to its last whole point. */
function clamp(value: number, size: number): number {
  return Math.max(0, Math.min(Math.max(0, Math.floor(size - 1)), Math.round(value)));
}

/**
 * The device point under a pointer on the shown frame, clamped to the screen; undefined when
 * the frame has no size on the page yet.
 */
export function devicePoint(
  frame: FrameSize,
  shown: { left: number; top: number; width: number; height: number },
  pointer: { x: number; y: number },
): { x: number; y: number } | undefined {
  if (shown.width <= 0 || shown.height <= 0) return undefined;
  const scale = frame.scale ?? 1;
  const width = frame.width / scale;
  const height = frame.height / scale;
  return {
    x: clamp(((pointer.x - shown.left) * width) / shown.width, width),
    y: clamp(((pointer.y - shown.top) * height) / shown.height, height),
  };
}

const swipeDistance = 8;
const longPressMs = 500;

/**
 * The gesture a press makes on the device: moved more than a few points is a swipe, held half a
 * second is a long press, anything else a tap where it was released.
 */
export function deviceGesture(
  start: { x: number; y: number; at: number },
  end: { x: number; y: number; at: number },
): DeviceInput {
  const durationMs = Math.max(1, Math.min(10_000, Math.round(end.at - start.at)));
  if (Math.abs(start.x - end.x) + Math.abs(start.y - end.y) > swipeDistance)
    return { kind: "swipe", x: start.x, y: start.y, toX: end.x, toY: end.y, durationMs };
  if (durationMs >= longPressMs) return { kind: "longPress", x: start.x, y: start.y, durationMs };
  return { kind: "tap", x: end.x, y: end.y };
}

/** "4:12" left on a control lease. */
export function leaseLeft(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
