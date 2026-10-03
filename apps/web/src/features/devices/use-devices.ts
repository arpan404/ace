import { DeviceClientError } from "@ace/client/devices";
import type { DeviceInput, DeviceOperation } from "@ace/protocol";
import { ThreadId } from "@ace/protocol";
import { deviceControls, deviceRows, type DeviceControls, type DeviceRow } from "@ace/ui-core";
import { useEffect, useState } from "react";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { useDeviceSession, type DeviceSession } from "./device-session.ts";

const enabledResult = (data: unknown): boolean =>
  typeof data === "object" && data !== null && "enabled" in data && data.enabled === true;

/** A failed device request, as one line and a hint. */
export interface DeviceProblem {
  message: string;
  hint: string;
}

function problem(error: unknown): DeviceProblem {
  if (error instanceof DeviceClientError) return { message: error.message, hint: error.hint };
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
}

/**
 * The Devices panel for one thread: the channel, the device list, the selected device and what
 * can be done with it. Every action is one request; a refusal shows its message and hint.
 */
export function useDevices(threadId: string) {
  const { endpoint } = useDaemonConnection();
  const { session, snapshot, reconnect } = useDeviceSession(endpoint);
  const [chosen, choose] = useState<string | undefined>();
  const [enabledLocally, setEnabled] = useState<boolean | undefined>();
  const [pending, setPending] = useState(0);
  const [failed, setFailed] = useState<DeviceProblem | undefined>();
  const connected = snapshot.connected;

  // Read the inventory each time the channel comes up.
  useEffect(() => {
    if (!session || !connected) return;
    void session.client
      .request({ op: "list" })
      .then(() => session.client.request({ op: "states" }))
      .catch((error: unknown) => setFailed(problem(error)));
  }, [session, connected]);

  const rows = deviceRows(snapshot.devices, snapshot.states);
  const selected = rows.find((row) => row.id === chosen) ?? rows[0];
  const state = snapshot.states.find((entry) => entry.device.id === selected?.id);
  const device = state?.device ?? snapshot.devices.find((entry) => entry.id === selected?.id);
  const enabled = snapshot.states.length
    ? snapshot.states.some((entry) => entry.enabled)
    : (enabledLocally ?? false);
  const now = useSeconds(state?.controller === "human");
  const controls = device && deviceControls(device, state, threadId, now);

  // Watch the selected device's stream while it is live; viewing is safe to restore.
  const streaming = connected && selected?.live ? selected.id : undefined;
  useEffect(() => {
    if (!session || !streaming) return;
    void session.client.request({ op: "subscribe", deviceId: streaming }).catch(() => {});
    return () => {
      void session.client.request({ op: "unsubscribe", deviceId: streaming }).catch(() => {});
    };
  }, [session, streaming]);

  const run = async (operation: DeviceOperation): Promise<unknown> => {
    if (!session) throw new DeviceClientError("disconnected", "Devices are offline");
    setPending((count) => count + 1);
    setFailed(undefined);
    try {
      return await session.client.request(operation);
    } finally {
      setPending((count) => count - 1);
    }
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
    failure: !connected && snapshot.error ? problem(snapshot.error) : undefined,
    enabled,
    rows,
    notes: snapshot.issues.map((issue) => ({ message: issue.message, hint: issue.hint })),
    selected,
    controls,
    pending: pending > 0,
    problem: failed,
    session,
  };
  return {
    view,
    reconnect,
    choose,
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
    boot: () => target && act(() => withControl({ op: "boot", deviceId: target })),
    shutdown: () => target && act(() => withControl({ op: "shutdown", deviceId: target })),
    start: () => target && act(() => run({ op: "start", deviceId: target, fps: 10 })),
    stop: () => target && act(() => run({ op: "stop", deviceId: target })),
    takeControl: () =>
      target && act(() => run({ op: "controller", deviceId: target, controller: "human" })),
    release: () =>
      target && act(() => run({ op: "controller", deviceId: target, controller: "none" })),
    input: (input: DeviceInput) =>
      target && act(() => withControl({ op: "input", deviceId: target, input })),
  };
}
