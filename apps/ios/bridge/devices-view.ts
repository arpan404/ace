import type { DeviceClientSnapshot } from "@ace/client/devices";
import type { DeviceState } from "@ace/protocol";
import {
  activityCaption,
  defaultScreens,
  deviceButtons,
  deviceCatalog,
  deviceControls,
  deviceKind,
  deviceProblem,
  deviceRows,
  frameGeometry,
  type DeviceProblem,
  type DeviceRow,
  type FrameGeometry,
  type PlatformFilter,
} from "@ace/ui-core/devices";

/*
 * A thread's Devices screen on the phone, shaped from the devices channel's snapshot with the
 * web's own rules (`@ace/ui-core/devices`): running devices, the catalog to start one, setup
 * problems, and the open device with who controls it, its hardware, its frame and the agent's
 * newest action. Pure; Swift draws it as sent.
 */

export interface Holder {
  threadId: string;
  agentId: string;
}
/** An agent of the open thread, as the phone names it. */
export interface AgentLabel {
  name: string;
  provider: string;
}

export interface DevicesViewInput {
  snapshot: Pick<
    DeviceClientSnapshot,
    "connected" | "inventoryLoaded" | "devices" | "states" | "issues" | "enabled" | "error"
  >;
  /** The channel was up and closed since. */
  closed: boolean;
  /** The machine answered the first reads with a refusal (no administrator access, say). */
  refused?: DeviceProblem | undefined;
  threadId: string | undefined;
  /** The device whose screen is open. */
  deviceId: string | undefined;
  /** The Start a device sheet's search and platform. */
  query: string;
  platform: PlatformFilter;
  now: number;
  /** An agent of the open thread; undefined for anyone else's. */
  agent(holder: Holder): AgentLabel | undefined;
  /** The agent each device was taken from, so the person can hand it back. */
  previous: ReadonlyMap<string, Holder>;
}

export interface DeviceTile {
  id: string;
  name: string;
  platform: "ios" | "android";
  kind: string;
  /** "iOS 18.4 · Live". */
  detail: string;
  running: boolean;
  live: boolean;
  /** "Claude is using it", "You're in control"; empty while nobody is. */
  control: string;
}

export interface DeviceControlLine {
  /** One sentence: "Claude is using iPhone 17 Pro", "You're in control"; empty while nobody is. */
  sentence: string;
  /** The one text action beside it. */
  action: "take" | "handBack" | "release" | "";
  /** Who Hand back returns the device to. */
  holder?: Holder | undefined;
}

export interface DeviceScreenView {
  id: string;
  name: string;
  platform: "ios" | "android";
  kind: string;
  /** "iOS 18.4 · Live". */
  subtitle: string;
  where: string;
  live: boolean;
  running: boolean;
  busy: boolean;
  cleanupRequired: boolean;
  recording: boolean;
  /** You can touch it: live and not held by an agent or another person. */
  interactive: boolean;
  control: DeviceControlLine;
  /** The side buttons ace can press, in the device's own words. */
  buttons: { label: string; key: string }[];
  /** The drawn hardware around the screen, upright and on its side. */
  frame: { portrait: FrameGeometry; landscape: FrameGeometry };
  /** The screen's size upright, in points, until its first picture says otherwise. */
  screen: { width: number; height: number };
  activity: { sequence: number; caption: string; provider: string; x?: number; y?: number } | null;
  problem: DeviceProblem | null;
  touch: string;
}

export interface PhoneDevicesView {
  connected: boolean;
  loading: boolean;
  enabled: boolean;
  /** Why the channel is down, once it failed or closed. */
  offline: DeviceProblem | null;
  running: DeviceTile[];
  /** The Start a device sheet: devices that are off, by kind, narrowed by its search. */
  groups: { label: string; rows: DeviceTile[] }[];
  /** Setup problems, one sentence each. */
  notes: DeviceProblem[];
  toolsMissing: boolean;
  device: DeviceScreenView | null;
}

/** Devices listed in the Start sheet; the rest are a search away. */
const catalogLimit = 200;

function holderName(input: DevicesViewInput, holder: Holder): string {
  if (holder.threadId !== input.threadId) return "An agent in another thread";
  return input.agent(holder)?.name ?? "An agent";
}

/** Who controls the device, as one sentence and the action a person has. */
export function controlLine(
  input: DevicesViewInput,
  state: DeviceState | undefined,
  name: string,
): DeviceControlLine {
  if (!state) return { sentence: "", action: "" };
  const controls = deviceControls(state.device, state, input.now);
  if (state.controller === "agent")
    return {
      sentence: `${state.holder ? holderName(input, state.holder) : "An agent"} is using ${name}`,
      action: "take",
    };
  if (controls.inControl) {
    const holder = input.previous.get(state.device.id);
    return holder
      ? { sentence: "You're in control", action: "handBack", holder }
      : { sentence: "You're in control", action: "release" };
  }
  if (state.controller === "human")
    return state.ownedHere
      ? { sentence: "Your control ended", action: "take" }
      : { sentence: "Someone else is in control", action: "take" };
  return { sentence: "", action: "" };
}

function tileControl(input: DevicesViewInput, state: DeviceState | undefined): string {
  if (!state) return "";
  if (state.controller === "agent")
    return `${state.holder ? holderName(input, state.holder) : "An agent"} is using it`;
  if (deviceControls(state.device, state, input.now).inControl) return "You're in control";
  if (state.controller === "human" && !state.ownedHere) return "Someone else is in control";
  return "";
}

function tile(input: DevicesViewInput, row: DeviceRow, state: DeviceState | undefined): DeviceTile {
  const controls = state && deviceControls(state.device, state, input.now);
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    kind: deviceKind(row),
    detail: controls ? [row.runtime, controls.where].filter(Boolean).join(" · ") : row.detail,
    running: row.running,
    live: row.live,
    control: tileControl(input, state),
  };
}

function screen(
  input: DevicesViewInput,
  row: DeviceRow,
  state: DeviceState | undefined,
): DeviceScreenView {
  const device = state?.device ??
    input.snapshot.devices.find((entry) => entry.id === row.id) ?? {
      id: row.id,
      name: row.name,
      platform: row.platform,
      state: row.running ? ("booted" as const) : ("shutdown" as const),
    };
  const controls = deviceControls(device, state, input.now);
  const kind = deviceKind(row);
  const upright = defaultScreens[kind];
  const portrait = {
    width: Math.min(upright.width, upright.height),
    height: Math.max(upright.width, upright.height),
  };
  const holder = state?.controller === "agent" ? state.holder : undefined;
  const activity = state?.activity;
  // Someone else's unexpired lease: the screen waits for Take over, as an agent's does.
  const othersLease =
    state?.controller === "human" &&
    state.ownedHere !== true &&
    (state.leaseExpiresAt ?? 0) > input.now;
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    kind,
    subtitle: [row.runtime, controls.where].filter(Boolean).join(" · "),
    where: controls.where,
    live: controls.live,
    running: controls.running,
    busy: controls.busy,
    cleanupRequired: controls.cleanupRequired,
    recording: state?.recording === true,
    interactive: controls.live && controls.controller !== "agent" && !othersLease,
    control: controlLine(input, state, row.name),
    buttons: deviceButtons(kind, row.name, 0).flatMap((button) =>
      button.key ? [{ label: button.label, key: button.key }] : [],
    ),
    frame: {
      portrait: frameGeometry(kind, row.name, portrait),
      landscape: frameGeometry(kind, row.name, { width: portrait.height, height: portrait.width }),
    },
    screen: { width: upright.width, height: upright.height },
    activity: activity
      ? {
          sequence: activity.sequence,
          caption: activityCaption(activity),
          provider: (holder && input.agent(holder)?.provider) ?? "",
          ...(activity.point ? { x: activity.point.x, y: activity.point.y } : {}),
        }
      : null,
    problem: controls.error ?? null,
    touch: state?.touch ?? "gestures",
  };
}

/** The whole Devices screen for one thread, from one snapshot of the devices channel. */
export function phoneDevicesView(input: DevicesViewInput): PhoneDevicesView {
  const { snapshot } = input;
  const states = new Map(snapshot.states.map((state) => [state.device.id, state]));
  const rows = deviceRows(snapshot.devices, snapshot.states);
  const catalog = deviceCatalog(rows, { query: input.query, platform: input.platform, uses: [] });
  let listed = 0;
  const groups = catalog.groups.flatMap((group) => {
    const off = group.rows.filter((row) => !row.running).slice(0, catalogLimit - listed);
    listed += off.length;
    return off.length
      ? [{ label: group.label, rows: off.map((row) => tile(input, row, states.get(row.id))) }]
      : [];
  });
  const running = rows
    .filter((row) => row.running)
    .toSorted((a, b) => Number(b.live) - Number(a.live))
    .map((row) => tile(input, row, states.get(row.id)));
  const selected = input.deviceId ? rows.find((row) => row.id === input.deviceId) : undefined;
  const offline: DeviceProblem | null = snapshot.connected
    ? !snapshot.inventoryLoaded && input.refused
      ? input.refused
      : null
    : snapshot.error
      ? deviceProblem({
          code: snapshot.error.code,
          message: snapshot.error.message,
          hint: snapshot.error.hint,
          permission: snapshot.error.permission,
        })
      : input.closed
        ? {
            message: "Lost the connection to this machine's simulators and emulators.",
            hint: "Reconnect to see them again.",
          }
        : null;
  return {
    connected: snapshot.connected,
    loading: !snapshot.inventoryLoaded,
    enabled:
      snapshot.enabled ??
      (snapshot.states.length ? snapshot.states.some((state) => state.enabled) : false),
    offline,
    running,
    groups,
    notes: snapshot.issues.map((issue) => deviceProblem(issue)),
    toolsMissing: snapshot.issues.some((issue) => issue.code === "tool_missing"),
    device: selected ? screen(input, selected, states.get(selected.id)) : null,
  };
}
