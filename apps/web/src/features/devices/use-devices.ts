import { DeviceClientError } from "@ace/client/devices";
import type { DeviceInput, DeviceOperation, DevicePermission } from "@ace/protocol";
import { AgentId, ThreadId } from "@ace/protocol";
import {
  deviceControls,
  deviceRows,
  type DeviceControls,
  type DeviceProblem,
  type DeviceRow,
} from "@ace/ui-core";
import { useEffect, useRef, useState } from "react";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { useDeviceSession, type DeviceSession } from "./device-session.ts";

const enabledResult = (data: unknown): boolean =>
  typeof data === "object" && data !== null && "enabled" in data && data.enabled === true;

export type { DeviceProblem } from "@ace/ui-core";

function problem(error: unknown): DeviceProblem {
  if (error instanceof DeviceClientError)
    return { message: error.message, hint: error.hint, permission: error.permission };
  return { message: error instanceof Error ? error.message : "That didn't work.", hint: "" };
}

/** The wall clock, ticking once a second while `active` so a control lease counts down. */
function useSeconds(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export interface DevicesView {
  connected: boolean;
  /** Set when the channel closed on an error; the panel offers to reconnect. */
  failure: DeviceProblem | undefined;
  enabled: boolean;
  rows: DeviceRow[];
  /** Missing SDKs or tools discovery reported. */
  notes: DeviceProblem[];
  selected: DeviceRow | undefined;
  controls: DeviceControls | undefined;
  pending: boolean;
  problem: DeviceProblem | undefined;
  session: DeviceSession | undefined;
  /** The agent holding the selected device, while one does. */
  holder: { threadId: string; agentId: string } | undefined;
}

/**
 * Devices for one thread: the channel, the device list and, with `deviceId`, that one device
 * and what can be done with it (a device's own tab). Every action is one request; a refusal
 * shows its message and hint.
 */
export function useDevices(threadId: string, deviceId?: string) {
  const { endpoint } = useDaemonConnection();
  const { session, snapshot, reconnect } = useDeviceSession(endpoint);
  const [enabledLocally, setEnabled] = useState<boolean | undefined>();
  const [pending, setPending] = useState(0);
  const [failed, setFailed] = useState<DeviceProblem | undefined>();
  const connected = snapshot.connected;

  // Read the inventory each time the channel comes up, and keep it current while this channel
  // (open only while a devices view is) stays up.
  useEffect(() => {
    if (!session || !connected) return;
    void session.client
      .request({ op: "inventory.watch", watching: true })
      .then(() => session.client.request({ op: "list" }))
      .then(() => session.client.request({ op: "states" }))
      .catch((error: unknown) => setFailed(problem(error)));
  }, [session, connected]);

  const rows = deviceRows(snapshot.devices, snapshot.states);
  const selected = deviceId === undefined ? undefined : rows.find((row) => row.id === deviceId);
  const state = snapshot.states.find((entry) => entry.device.id === selected?.id);
  const device = state?.device ?? snapshot.devices.find((entry) => entry.id === selected?.id);
  const enabled =
    snapshot.enabled ??
    (snapshot.states.length
      ? snapshot.states.some((entry) => entry.enabled)
      : (enabledLocally ?? false));
  const now = useSeconds(state?.controller === "human");
  const controls = device && deviceControls(device, state, threadId, now);

  // Watch the selected device's stream while it is live; viewing is safe to restore. Every
  // view of one device shares a single stream, closed when the last of them leaves.
  const streaming = connected && selected?.live ? selected.id : undefined;
  useEffect(() => {
    if (!session || !streaming) return;
    return session.client.retainStream(streaming);
  }, [session, streaming]);

  // A running device shows its screen as soon as its tab opens: start the live view once per
  // device while the tab is open. A failure (a missing permission, say) waits for Try again.
  const autoStarted = useRef(new Set<string>());
  const idle =
    connected &&
    enabled &&
    selected?.running === true &&
    (state === undefined || state.lifecycle === "idle")
      ? selected.id
      : undefined;
  useEffect(() => {
    if (!session || !idle || autoStarted.current.has(idle)) return;
    autoStarted.current.add(idle);
    void session.client
      .request({ op: "start", deviceId: idle, fps: 60 })
      .catch((error: unknown) => setFailed(problem(error)));
  }, [session, idle]);

  /** One request, counted as pending; whatever went wrong before stays on show. */
  const send = async (operation: DeviceOperation): Promise<unknown> => {
    if (!session) throw new DeviceClientError("disconnected", "Devices are offline");
    setPending((count) => count + 1);
    try {
      return await session.client.request(operation);
    } finally {
      setPending((count) => count - 1);
    }
  };
  /** A new attempt: the last problem clears while it runs. */
  const run = (operation: DeviceOperation): Promise<unknown> => {
    setFailed(undefined);
    return send(operation);
  };
  const act = (operation: () => Promise<unknown>) => {
    void operation().catch((error: unknown) => setFailed(problem(error)));
  };
  /** Boot, shutdown and input need a control lease; take it first when it isn't held. */
  const withControl = async (operation: DeviceOperation) => {
    if (!controls?.inControl && selected)
      await run({ op: "controller", deviceId: selected.id, controller: "human" });
    return run(operation);
  };
  const target = selected?.id;

  const view: DevicesView = {
    connected,
    failure: connected
      ? undefined
      : snapshot.error
        ? problem(snapshot.error)
        : snapshot.closed
          ? {
              message: "Lost the connection to this machine's simulators and emulators.",
              hint: "Reconnect to see them again.",
            }
          : undefined,
    enabled,
    rows,
    notes: snapshot.issues.map((issue) => ({ message: issue.message, hint: issue.hint })),
    selected,
    controls,
    pending: pending > 0,
    problem: failed,
    session,
    holder: state?.controller === "agent" ? state.holder : undefined,
  };
  return {
    view,
    threadId,
    reconnect,
    enable: (on: boolean) =>
      act(async () => {
        setEnabled(enabledResult(await run({ op: "enable", enabled: on })));
        await run({ op: "list" });
        await run({ op: "states" });
      }),
    approve: (allowed: boolean) =>
      target &&
      act(() =>
        run({ op: "approve", deviceId: target, threadId: ThreadId.parse(threadId), allowed }),
      ),
    /** Boot, then show its screen: booting is how a person asks to see the device. */
    boot: () =>
      target &&
      act(async () => {
        autoStarted.current.add(target);
        await withControl({ op: "boot", deviceId: target });
        await run({ op: "start", deviceId: target, fps: 60 });
      }),
    shutdown: () => target && act(() => withControl({ op: "shutdown", deviceId: target })),
    start: () => target && act(() => run({ op: "start", deviceId: target, fps: 60 })),
    stop: () => target && act(() => run({ op: "stop", deviceId: target })),
    /**
     * Ask macOS for a permission the screen helper lacks: on the Mac running ace this shows the
     * system prompt, or opens its Privacy & Security pane with Ace Screen Helper listed.
     */
    grant: (permission: DevicePermission) =>
      // The guidance stays until the person tries again: they still have a switch to turn on.
      act(() => send({ op: "permissions.request", permission })),
    /** Try the live view again, as after granting a permission. */
    retry: () => target && act(() => run({ op: "start", deviceId: target, fps: 60 })),
    takeControl: () =>
      target && act(() => run({ op: "controller", deviceId: target, controller: "human" })),
    release: () =>
      target && act(() => run({ op: "controller", deviceId: target, controller: "none" })),
    /** Hand the device to one of this thread's agents; the daemon checks it is approved here. */
    delegate: (agentId: string) =>
      target &&
      act(() =>
        run({
          op: "controller",
          deviceId: target,
          controller: "agent",
          threadId: ThreadId.parse(threadId),
          agentId: AgentId.parse(agentId),
        }),
      ),
    /**
     * One input, resolved once the device acknowledged or refused it (a refusal shows as the
     * problem), so a drag keeps a single move in flight. It never rejects and is never replayed.
     * Input while in control skips the pending count: a drag must not re-render the whole tab.
     */
    input: async (input: DeviceInput): Promise<void> => {
      if (!target) return;
      try {
        if (!controls?.inControl) await withControl({ op: "input", deviceId: target, input });
        else {
          if (failed) setFailed(undefined);
          if (!session) throw new DeviceClientError("disconnected", "Devices are offline");
          await session.client.request({ op: "input", deviceId: target, input });
        }
      } catch (error) {
        setFailed(problem(error));
      }
    },
  };
}
