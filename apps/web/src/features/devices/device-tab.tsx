import { CaretLeftIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { toolbarEdge } from "@/components/ui/rules.ts";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import { cn } from "@/lib/cn.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { ActivityCaption, useFreshActivity } from "./activity-overlay.tsx";
import { ControlRail, takeControlReason } from "./control-rail.tsx";
import { controllerOf } from "./controller-label.tsx";
import { DeviceDrawer } from "./device-drawer.tsx";
import { DeviceHeader } from "./device-header.tsx";
import { needsPermission, PermissionGuide } from "./device-permission.tsx";
import { noteDeviceUse, takeBootRequest, useScreenOnly } from "./device-prefs.ts";
import { Problem } from "./device-problem.tsx";
import { DeviceStage, type Bounds } from "./device-stage.tsx";
import type { ShownScreen } from "./device-screen.tsx";
import { DevicesMenu } from "./devices-menu.tsx";
import { KeyboardField } from "./keyboard-field.tsx";
import { StreamMeter, streamSummary, type StreamStats } from "./stream-stats.ts";
import { useDevices, type DeviceProblem } from "./use-devices.ts";

type Devices = ReturnType<typeof useDevices>;

/** The stream's subtitle numbers, read once a second from the frames the screen drew. */
function useStreamStats(sameClock: boolean, live: boolean) {
  const meter = useMemo(() => new StreamMeter({ sameClock }), [sameClock]);
  const [stats, setStats] = useState<StreamStats>();
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setStats(meter.read(Date.now())), 1000);
    return () => clearInterval(timer);
  }, [meter, live]);
  const onFrame = (shown: ShownScreen) =>
    meter.add({
      codec: shown.codec,
      capturedAt: shown.capturedAt,
      shownAt: Date.now(),
    });
  return { stats: live ? stats : undefined, onFrame };
}

/** Over the dimmed frame when the screen isn't streaming: what the device is doing, and the next step. */
function IdleCard(props: { children: ReactNode }) {
  return (
    <div className="ace-floating-solid flex max-w-72 flex-col items-center gap-3 rounded-lg px-5 py-4 text-center text-ui text-muted-foreground">
      {props.children}
    </div>
  );
}

/** The device: header, the stage with its live screen and rail, and the drawer. */
function SelectedDevice(props: { devices: Devices }) {
  const { devices } = props;
  const { view } = devices;
  const { selected, controls, session } = view;
  const actions = useWorkspaceActions(devices.threadId);
  const scope = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [keyboard, setKeyboard] = useState(false);
  const [highlight, setHighlight] = useState<Bounds>();
  const bare = useScreenOnly();
  const controlled = controls?.inControl === true;
  const live = controls?.live === true;
  const { stats, onFrame } = useStreamStats(session?.connection === "local", live);
  const shown = useFreshActivity(view.activity);
  // A missing macOS permission gets its own guidance instead of a one-line error.
  const permission = [view.problem, controls?.error].find(needsPermission);
  const toggle = () => {
    if (view.pending || !controls?.running) return;
    if (controlled) devices.release();
    else devices.takeControl();
  };
  useHotkey(keymap.takeControl.keys, toggle, { enabled: live });
  if (!selected || !controls || !session) return null;
  const state = view.controllers.get(selected.id);
  const controller = controllerOf(state ?? { controller: "none" });
  const problems = [view.problem, controls.error].filter(
    (problem): problem is DeviceProblem => problem !== undefined && !needsPermission(problem),
  );
  const idle = controls.busy ? (
    <IdleCard>
      <Spinner />
      <p>{controls.where}</p>
    </IdleCard>
  ) : controls.cleanupRequired ? (
    <IdleCard>
      <p>The live view didn't stop cleanly.</p>
      <Button size="sm" variant="secondary" disabled={view.pending} onClick={devices.stop}>
        Retry cleanup
      </Button>
    </IdleCard>
  ) : controls.running ? (
    <IdleCard>
      <p>The live view is off.</p>
      <Button size="sm" variant="secondary" disabled={view.pending} onClick={devices.start}>
        Start live view
      </Button>
    </IdleCard>
  ) : (
    <IdleCard>
      <p>{selected.name} is off.</p>
      <Button size="sm" variant="primary" disabled={view.pending} onClick={devices.boot}>
        Boot
      </Button>
    </IdleCard>
  );
  return (
    <section ref={scope} aria-label={selected.name} className="flex h-full min-h-0 flex-col">
      <DeviceHeader
        name={selected.name}
        subtitle={[
          ...(selected.runtime ? [selected.runtime] : []),
          controls.where,
          ...(live ? streamSummary(stats) : []),
        ]}
        busy={controls.busy}
        onBack={() => actions.open({ kind: "devices" })}
        control={{
          running: controls.running,
          controller,
          leaseLeftMs: controls.leaseLeftMs,
          threadId: devices.threadId,
          disabled: view.pending,
          onTake: devices.takeControl,
          onRelease: devices.release,
          onDelegate: (agentId) => devices.delegate(agentId),
        }}
        menu={<DevicesMenu devices={devices} />}
      />
      {problems.length > 0 && (
        <div className={cn("flex shrink-0 flex-col gap-1 px-3 py-2", toolbarEdge)}>
          {problems.map((problem) => (
            <Problem key={problem.message} problem={problem} />
          ))}
        </div>
      )}
      {permission && live && (
        <PermissionGuide problem={permission} devices={devices} pending={view.pending} compact />
      )}
      {permission && !live ? (
        <PermissionGuide problem={permission} devices={devices} pending={view.pending} />
      ) : (
        <DeviceStage
          ref={stage}
          row={selected}
          session={session}
          live={live}
          interactive={controlled}
          bare={bare}
          press={{
            enabled: controlled && live,
            reason: live ? takeControlReason : undefined,
            onPress: (key) => void devices.input({ kind: "key", key }),
          }}
          onInput={devices.input}
          onFrame={onFrame}
          activity={shown}
          highlight={highlight}
          idle={idle}
          rail={
            <ControlRail
              scope={scope}
              android={selected.platform === "android"}
              controlled={controlled}
              live={live}
              pending={view.pending}
              recording={devices.recording}
              keyboardOpen={keyboard && controlled}
              onKey={(key) => void devices.input({ kind: "key", key })}
              onKeyboard={() => setKeyboard((open) => !open)}
              onScreenshot={devices.screenshot}
              onRecord={devices.record}
            />
          }
          footer={
            <>
              {keyboard && controlled && live && (
                <KeyboardField
                  onInput={(input) => void devices.input(input)}
                  onClose={() => {
                    setKeyboard(false);
                    stage.current?.focus();
                  }}
                />
              )}
              <ActivityCaption shown={shown} holder={view.holder} />
            </>
          }
        />
      )}
      <DeviceDrawer
        devices={devices}
        session={session}
        deviceId={selected.id}
        live={live}
        onHighlight={setHighlight}
      />
    </section>
  );
}

/** The device tab's shape while it connects or loads: header and stage, values as skeletons. */
function DeviceSkeleton(props: { name: string; onBack(): void }) {
  return (
    <LoadingRegion label={props.name} className="flex h-full min-h-0 flex-col">
      <div className={cn("flex h-11 shrink-0 items-center gap-1.5 pr-1.5 pl-1", toolbarEdge)}>
        <IconButton icon={CaretLeftIcon} label="All devices" onClick={props.onBack} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-ui font-medium text-foreground">{props.name}</span>
          <Skeleton className="h-2.5 w-32" />
        </div>
      </div>
      <div className="min-h-0 flex-1 bg-(--device-stage)" />
    </LoadingRegion>
  );
}

/**
 * One simulator or emulator as a workspace tab: boot it, watch it live, drive it or hand it to
 * an agent, and read its logs and UI tree. The device keeps its own identity when the channel
 * drops or devices are off, so the tab says which device it is waiting for.
 */
export function DeviceTab(props: {
  threadId: string;
  deviceId: string;
  /** The name the tab was opened with, shown while the device list loads. */
  name: string | undefined;
  /** The tab's key, to keep its title in step with the device's name. */
  tabKey: string;
}) {
  const devices = useDevices(props.threadId, props.deviceId);
  const actions = useWorkspaceActions(props.threadId);
  const { view } = devices;
  const name = view.selected?.name ?? props.name ?? "This device";
  const known = view.selected?.name;
  useEffect(() => {
    if (known && known !== props.name) actions.update(props.tabKey, { title: known });
  }, [known, props.name, props.tabKey, actions]);
  useEffect(() => noteDeviceUse(props.deviceId, Date.now()), [props.deviceId]);
  // Boot asked for from the list's Recent row: done here, once the device is known to be off.
  const off =
    view.connected && view.enabled && view.selected !== undefined && !view.selected.running;
  const { boot } = devices;
  useEffect(() => {
    if (off && takeBootRequest(props.deviceId)) boot();
  }, [off, props.deviceId, boot]);
  const back = () => actions.open({ kind: "devices" });
  if (!view.connected)
    return view.failure ? (
      <EmptyState
        title={`${name} is out of reach`}
        description={`${view.failure.message} ${view.failure.hint}`.trim()}
        action={<Button onClick={devices.reconnect}>Reconnect</Button>}
      />
    ) : (
      <DeviceSkeleton name={name} onBack={back} />
    );
  if (view.loading)
    return view.problem ? (
      <EmptyState
        title={`Couldn't load ${name}`}
        description={`${view.problem.message} ${view.problem.hint}`.trim()}
        action={<Button onClick={devices.reconnect}>Try again</Button>}
      />
    ) : (
      <DeviceSkeleton name={name} onBack={back} />
    );
  if (!view.enabled)
    return (
      <EmptyState
        title="Devices are off on this machine"
        description={`Turn devices on to see ${name} and let agents in this thread use it.`}
        action={
          <div className="flex flex-col items-center gap-3">
            <Button variant="primary" disabled={view.pending} onClick={() => devices.enable(true)}>
              Enable devices
            </Button>
            {view.problem && <Problem problem={view.problem} />}
          </div>
        }
      />
    );
  if (!view.selected)
    return (
      <EmptyState
        title={view.problem ? `Couldn't load ${name}` : `${name} isn't on this machine any more`}
        description={
          view.problem
            ? `${view.problem.message} ${view.problem.hint}`.trim()
            : "The simulator or emulator was deleted, or its SDK went away. Close this tab, or pick another device."
        }
        action={
          <Button size="sm" variant="secondary" onClick={back}>
            All devices
          </Button>
        }
      />
    );
  return <SelectedDevice devices={devices} />;
}
