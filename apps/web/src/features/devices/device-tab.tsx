import type { ReactNode } from "react";
import type { DeviceInput } from "@ace/protocol";
import { leaseLeft } from "@ace/ui-core";
import {
  AndroidLogoIcon,
  AppleLogoIcon,
  ArrowClockwiseIcon,
  ArrowUUpLeftIcon,
  DeviceMobileIcon,
  HouseSimpleIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useSidebarThread } from "@ace/client-react";
import { DelegateMenu, useAgentLabel } from "@/components/agent-picker.tsx";
import { ControlToggle } from "@/components/control-toggle.tsx";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { DeviceLogs } from "./device-logs.tsx";
import { DeviceScreen } from "./device-screen.tsx";
import { DevicesMenu } from "./devices-menu.tsx";
import { needsPermission, PermissionGuide } from "./device-permission.tsx";
import { useDevices, type DeviceProblem } from "./use-devices.ts";

export function Problem(props: { problem: DeviceProblem }) {
  return (
    <p role="alert" className="text-sm text-muted-foreground">
      <span className="text-foreground">{props.problem.message}</span>
      {props.problem.hint && ` ${props.problem.hint}`}
    </p>
  );
}

function TypeText(props: { disabled: boolean; onInput(input: DeviceInput): void }) {
  const [text, setText] = useState("");
  return (
    <form
      className="flex gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!text) return;
        props.onInput({ kind: "type", text });
        setText("");
      }}
    >
      <Input
        aria-label="Type on the device"
        placeholder={props.disabled ? "Take control to type on the device" : "Type on the device"}
        value={text}
        disabled={props.disabled}
        onChange={(event) => setText(event.currentTarget.value)}
      />
      <Button type="submit" size="sm" variant="outline" disabled={props.disabled || !text}>
        Send
      </Button>
    </form>
  );
}

type Devices = ReturnType<typeof useDevices>;

/** Home, Back (Android) and Rotate, then a line to type on the device. */
function DeviceKeys(props: {
  devices: Devices;
  android: boolean;
  controlled: boolean;
  /** Take control / Hand back, in the same row as the keys. */
  control: ReactNode;
}) {
  const { devices, controlled } = props;
  return (
    <div className="flex shrink-0 flex-col gap-2">
      <div className="flex items-center justify-center gap-1">
        <IconButton
          icon={HouseSimpleIcon}
          label="Home"
          disabled={!controlled}
          onClick={() => devices.input({ kind: "key", key: "home" })}
        />
        {props.android && (
          <IconButton
            icon={ArrowUUpLeftIcon}
            label="Back"
            disabled={!controlled}
            onClick={() => devices.input({ kind: "key", key: "back" })}
          />
        )}
        <IconButton
          icon={ArrowClockwiseIcon}
          label="Rotate"
          disabled={!controlled}
          onClick={() => devices.input({ kind: "key", key: "rotate" })}
        />
        <span className="ml-2">{props.control}</span>
      </div>
      <TypeText disabled={!controlled} onInput={devices.input} />
    </div>
  );
}

/**
 * Who holds the device for this thread: an agent (named, with its thread when it is another
 * one), you, or nobody. Delegate hands it to one of this thread's agents; Take back ends the
 * agent's hold. The daemon decides whether that agent may have it.
 */
function Holder(props: { devices: Devices; threadId: string; controlled: boolean }) {
  const { devices } = props;
  const holder = devices.view.holder;
  const name = useAgentLabel(holder?.threadId, holder?.agentId);
  const thread = useSidebarThread(holder?.threadId ?? "");
  const pending = devices.view.pending;
  return (
    <div className="flex shrink-0 items-center gap-3 text-ui">
      <span className="min-w-0 flex-1 truncate">
        {holder
          ? `${name} is using it${holder.threadId !== props.threadId && thread ? ` · ${thread.title}` : ""}`
          : props.controlled
            ? "You're using it"
            : "No agent is using it"}
      </span>
      {holder ? (
        <Button size="sm" variant="ghost" disabled={pending} onClick={devices.takeControl}>
          Take back
        </Button>
      ) : (
        <DelegateMenu
          threadId={props.threadId}
          label="Delegate to an agent"
          disabled={pending}
          onDelegate={(agentId) => devices.delegate(agentId)}
        />
      )}
    </div>
  );
}

/** The device: who can use it, its live screen with the control bar, its keys and logs. */
function SelectedDevice(props: { devices: Devices }) {
  const { devices } = props;
  const { view } = devices;
  const { selected, controls, session } = view;
  const controlled = controls?.inControl === true;
  const live = controls?.live === true;
  // A missing macOS permission gets its own guidance instead of a one-line error.
  const permission = [view.problem, controls?.error].find(needsPermission);
  const toggle = () => {
    if (view.pending || !controls?.running) return;
    if (controlled) devices.release();
    else devices.takeControl();
  };
  useHotkey(keymap.takeControl.keys, toggle, { enabled: live });
  if (!selected || !controls || !session) return null;
  return (
    <section aria-label={selected.name} className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b pr-1.5 pl-3">
        <Icon
          icon={selected.platform === "ios" ? AppleLogoIcon : AndroidLogoIcon}
          size={14}
          className="text-muted-foreground"
        />
        <p className="min-w-0 flex-1 truncate text-sm text-subtle-foreground">
          <span className="font-medium text-foreground">{selected.name}</span>
          {` · ${controls.status}`}
        </p>
        {controlled && (
          <span className="text-xs text-subtle-foreground tabular-nums">
            {leaseLeft(controls.leaseLeftMs)} left
          </span>
        )}
        <DevicesMenu devices={devices} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 px-3 py-2.5">
        <div className="flex shrink-0 items-center gap-3 text-ui">
          <span className="min-w-0 flex-1">
            {controls.approvedHere
              ? "Agents in this thread can use it"
              : "Agents in this thread can't use it yet"}
            {controls.approvedElsewhere && (
              <span className="block text-xs text-subtle-foreground">
                Approved for another thread; approving here moves it.
              </span>
            )}
          </span>
          {controls.approvedHere ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={view.pending}
              onClick={() => devices.approve(false)}
            >
              Revoke
            </Button>
          ) : (
            <Button size="sm" disabled={view.pending} onClick={() => devices.approve(true)}>
              Approve
            </Button>
          )}
        </div>
        {controls.approvedHere && controls.running && (
          <Holder devices={devices} threadId={devices.threadId} controlled={controlled} />
        )}
        {view.problem && !needsPermission(view.problem) && <Problem problem={view.problem} />}
        {controls.error && !needsPermission(controls.error) && <Problem problem={controls.error} />}
        {permission && live && (
          <PermissionGuide problem={permission} devices={devices} pending={view.pending} compact />
        )}
        {permission && !live ? (
          <PermissionGuide problem={permission} devices={devices} pending={view.pending} />
        ) : live ? (
          <>
            {/* The screen takes what the tab has left, so the whole device shows at once. */}
            <div className="relative min-h-[160px] flex-1">
              <div className="absolute inset-0 flex items-center justify-center">
                <DeviceScreen
                  session={session}
                  deviceId={selected.id}
                  name={selected.name}
                  interactive={controlled}
                  onInput={devices.input}
                />
              </div>
            </div>
            {/* Under the screen, in flow, so it never covers what the device shows. */}
            <DeviceKeys
              devices={devices}
              android={selected.platform === "android"}
              controlled={controlled}
              control={
                <ControlToggle
                  inControl={controlled}
                  disabled={view.pending || !controls.running}
                  onToggle={toggle}
                />
              }
            />
          </>
        ) : (
          <div className="grid min-h-[160px] flex-1 place-items-center rounded-xl bg-secondary/40">
            <div className="flex flex-col items-center gap-2 text-center">
              <p className="text-sm text-muted-foreground">
                {controls.running ? "The live view is off." : `${selected.name} is off.`}
              </p>
              {controls.running ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={view.pending || controls.busy}
                  onClick={devices.start}
                >
                  {controls.busy && <Spinner />}
                  Start live view
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled={view.pending} onClick={devices.boot}>
                  Boot
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="shrink-0">
        <DeviceLogs key={selected.id} session={session} deviceId={selected.id} />
      </div>
    </section>
  );
}

/**
 * One simulator or emulator as a workspace tab: approve it for the thread, boot it, watch it
 * live, take control, and read its logs. The device keeps its own identity when the channel
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
  const backToDevices = (
    <Button size="sm" variant="outline" onClick={() => actions.open({ kind: "devices" })}>
      All devices
    </Button>
  );
  if (!view.connected)
    return view.failure ? (
      <EmptyState
        icon={DeviceMobileIcon}
        title={`${name} is out of reach`}
        description={`${view.failure.message} ${view.failure.hint}`.trim()}
        action={<Button onClick={devices.reconnect}>Reconnect</Button>}
      />
    ) : (
      <div className="grid h-full place-items-center">
        <Spinner label={`Connecting to ${name}`} />
      </div>
    );
  if (!view.enabled)
    return (
      <EmptyState
        icon={DeviceMobileIcon}
        title="Devices are off on this machine"
        description={`Turn devices on to see ${name} and let agents in this thread use it once you approve it.`}
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
        icon={DeviceMobileIcon}
        title={`${name} isn't on this machine any more`}
        description="The simulator or emulator was deleted, or its SDK went away. Close this tab, or pick another device."
        action={backToDevices}
      />
    );
  return <SelectedDevice devices={devices} />;
}
