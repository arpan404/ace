import { useToast } from "@/components/ui/toast.tsx";
import { DeviceClientError } from "@ace/client/devices";
import type {
  DeviceActivity,
  DeviceInput,
  DeviceOperation,
  DevicePermission,
  DevicePosture,
  DeviceSettings,
  DeviceState,
} from "@ace/protocol";
import { ThreadId, ScreenUITreeResult } from "@ace/protocol";
import {
  deviceControls,
  deviceProblem,
  deviceRows,
  holdsControl,
  inventoryNotes,
  platformFailure,
  type DeviceControls,
  type DeviceProblem,
  type DeviceRow,
} from "@ace/ui-core";
import { useEffect, useRef, useState } from "react";
import { copyImageToClipboard } from "@/lib/clipboard-image.ts";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { useDeviceSession, type DeviceSession } from "./device-session.ts";

const enabledResult = (data: unknown): boolean =>
  typeof data === "object" && data !== null && "enabled" in data && data.enabled === true;

export type { DeviceProblem } from "@ace/ui-core";

function problem(error: unknown): DeviceProblem {
  if (error instanceof DeviceClientError)
    return deviceProblem({
      code: error.code,
      message: error.message,
      hint: error.hint,
      permission: error.permission,
    });
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
  loading: boolean;
  /** Set when the channel closed on an error; the panel offers to reconnect. */
  failure: DeviceProblem | undefined;
  enabled: boolean;
  rows: DeviceRow[];
  /** Missing SDKs or tools discovery reported. */
  notes: DeviceProblem[];
  /** Discovery found the device tools ace downloads (serve-sim, the scrcpy server) missing. */
  toolsMissing: boolean;
  /** The device tools are downloading. */
  downloadingTools: boolean;
  selected: DeviceRow | undefined;
  controls: DeviceControls | undefined;
  pending: boolean;
  problem: DeviceProblem | undefined;
  session: DeviceSession | undefined;
  /** The agent holding the selected device, while one does. */
  holder: { threadId: string; agentId: string } | undefined;
  /** The last thing an agent did on the selected device. */
  activity: DeviceActivity | undefined;
  /** Every device's controller and holder, for the list's tiles. */
  controllers: ReadonlyMap<string, Pick<DeviceState, "controller" | "holder" | "ownedHere">>;
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
  const [downloadingTools, setDownloadingTools] = useState(false);
  const [failed, setFailed] = useState<DeviceProblem | undefined>();
  const connected = snapshot.connected;
  const { add: notify } = useToast();
  const claim = useRef<Promise<unknown> | undefined>(undefined);
  const noticed = useRef<string | undefined>(undefined);

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
  const notice = state?.recordingNotice;
  useEffect(() => {
    if (notice && notice !== noticed.current) notify({ title: notice });
    noticed.current = notice;
  }, [notice, notify, noticed]);
  const now = useSeconds(state?.controller === "human");
  const controls = device && deviceControls(device, state, now);

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
  // A channel that came back starts a view the daemon stopped meanwhile; one seen live and
  // then stopped by hand stays stopped.
  const liveNow = connected && state?.lifecycle === "live" ? state.device.id : undefined;
  useEffect(() => {
    if (!connected) autoStarted.current.clear();
    else if (liveNow) autoStarted.current.add(liveNow);
  }, [connected, liveNow]);
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
    const id = "deviceId" in operation ? operation.deviceId : selected?.id;
    const current = session?.client.getSnapshot().states.find((entry) => entry.device.id === id);
    if (id && !holdsControl(current, Date.now())) {
      claim.current ??= run({
        op: "controller",
        deviceId: id,
        controller: "human",
        threadId: ThreadId.parse(threadId),
      }).finally(() => {
        claim.current = undefined;
      });
      await claim.current;
    }
    return run(operation);
  };
  const target = selected?.id;
  /** serve-sim and the scrcpy server, downloaded by the daemon in a process of their own. */
  const downloadTools = async () => {
    setDownloadingTools(true);
    try {
      await run({ op: "tools.install" });
    } finally {
      setDownloadingTools(false);
    }
  };

  const view: DevicesView = {
    connected,
    loading: !snapshot.inventoryLoaded,
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
    notes: inventoryNotes(snapshot.issues),
    toolsMissing: snapshot.issues.some((issue) => issue.code === "tool_missing"),
    downloadingTools,
    selected,
    controls,
    pending: pending > 0,
    // The open device's own failure only: the machine's other notices are `notes`.
    problem:
      failed ?? (deviceId === undefined ? undefined : platformFailure(snapshot.issues, deviceId)),
    session,
    holder: state?.controller === "agent" ? state.holder : undefined,
    activity: state?.activity,
    controllers: new Map(
      snapshot.states.map((entry) => [
        entry.device.id,
        { controller: entry.controller, holder: entry.holder, ownedHere: entry.ownedHere },
      ]),
    ),
  };
  return {
    view,
    threadId,
    reconnect,
    /** Turning devices on also downloads the tools ace runs, so they are there from the start. */
    enable: (on: boolean) =>
      act(async () => {
        setEnabled(enabledResult(await run({ op: "enable", enabled: on })));
        await run({ op: "list" });
        await run({ op: "states" });
        // The list shows at once; the download runs beside it and a failure stays on show.
        if (on) {
          await downloadTools();
          await run({ op: "list" });
        }
      }),
    downloadTools: () =>
      act(async () => {
        await downloadTools();
        await run({ op: "list" });
      }),
    /** Boot, then show its screen: booting is how a person asks to see the device. */
    boot: () =>
      target &&
      act(async () => {
        autoStarted.current.add(target);
        await withControl({ op: "boot", deviceId: target });
        await run({ op: "start", deviceId: target, fps: 60 });
      }),
    /** Read the inventory and every device's state again. */
    refresh: () =>
      act(async () => {
        await run({ op: "list" });
        await run({ op: "states" });
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
    action: (operation: DeviceOperation) => act(() => withControl(operation)),
    install: (path: string) =>
      target && act(() => withControl({ op: "install", deviceId: target, path })),
    openUrl: (url: string) =>
      target && act(() => withControl({ op: "open_url", deviceId: target, url })),
    openApp: (appId: string) =>
      target && act(() => withControl({ op: "open_app", deviceId: target, appId })),
    configure: (settings: DeviceSettings) =>
      target && act(() => withControl({ op: "configure", deviceId: target, settings })),
    /** A foldable device's posture; absent for every device ace can't fold. */
    posture: state?.posture,
    fold: (posture: DevicePosture) =>
      target && act(() => withControl({ op: "posture", deviceId: target, posture })),
    /** The accessibility tree agents read, with their `@eN` refs. */
    uiTree: async (): Promise<ScreenUITreeResult | undefined> => {
      if (!target || !session) return undefined;
      return ScreenUITreeResult.parse(
        await session.client.request({
          op: "ui.tree",
          deviceId: target,
          maxDepth: 16,
          maxNodes: 512,
        }),
      );
    },
    recording: state?.recording === true,
    record: () =>
      target &&
      act(async () => {
        await withControl({
          op: state?.recording ? "record.stop" : "record.start",
          deviceId: target,
        });
      }),
    /** A still of the screen, put on the clipboard (never a download). */
    screenshot: () =>
      target &&
      act(async () => {
        if (!session) return;
        setFailed(undefined);
        // Handed over pending, so Safari keeps the click's permission while the still arrives.
        const image = session.client
          .screenshot(target)
          .then((picture) => new Blob([picture.bytes.slice()], { type: "image/jpeg" }));
        await copyImageToClipboard(image);
        notify({ title: "Screenshot copied" });
      }),
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
