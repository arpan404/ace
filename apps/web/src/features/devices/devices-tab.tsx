import type { DeviceInput } from "@ace/protocol";
import { leaseLeft, type DeviceRow } from "@ace/ui-core";
import {
  AndroidLogoIcon,
  AppleLogoIcon,
  ArrowClockwiseIcon,
  ArrowUUpLeftIcon,
  DeviceMobileIcon,
  HouseSimpleIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { ControlBar, ControlToggle } from "@/components/control-toggle.tsx";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import { DeviceLogs } from "./device-logs.tsx";
import { DeviceScreen } from "./device-screen.tsx";
import { DevicesMenu } from "./devices-menu.tsx";
import { useDevices, type DeviceProblem } from "./use-devices.ts";

function Problem(props: { problem: DeviceProblem }) {
  return (
    <p role="alert" className="text-sm text-muted-foreground">
      <span className="text-foreground">{props.problem.message}</span>
      {props.problem.hint && ` ${props.problem.hint}`}
    </p>
  );
}

function DeviceList(props: {
  rows: readonly DeviceRow[];
  selected: string | undefined;
  onSelect(id: string): void;
}) {
  return (
    <ul aria-label="Devices" className="flex flex-col gap-px px-1.5 py-1.5">
      {props.rows.map((row) => {
        const active = row.id === props.selected;
        return (
          <li key={row.id}>
            <button
              type="button"
              aria-current={active || undefined}
              onClick={() => props.onSelect(row.id)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-accent",
                active && "bg-accent",
              )}
            >
              <Icon
                icon={row.platform === "ios" ? AppleLogoIcon : AndroidLogoIcon}
                size={16}
                active={active}
                className="text-muted-foreground"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui font-medium">{row.name}</span>
                <span className="block truncate text-xs text-subtle-foreground">{row.detail}</span>
              </span>
              {row.live && <span className="text-xs text-muted-foreground">Live</span>}
            </button>
          </li>
        );
      })}
    </ul>
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
        placeholder="Type on the device"
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
function DeviceKeys(props: { devices: Devices; android: boolean; controlled: boolean }) {
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
      </div>
      <TypeText disabled={!controlled} onInput={devices.input} />
    </div>
  );
}

/** The selected device: who can use it, its live screen with the control bar, and its keys. */
function SelectedDevice(props: { devices: Devices }) {
  const { devices } = props;
  const { view } = devices;
  const { selected, controls, session } = view;
  const controlled = controls?.inControl === true;
  const live = controls?.live === true;
  const toggle = () => {
    if (view.pending || !controls?.running) return;
    if (controlled) devices.release();
    else devices.takeControl();
  };
  useHotkey(keymap.takeControl.keys, toggle, { enabled: live });
  if (!selected || !controls || !session) return null;
  return (
    <section
      aria-label={selected.name}
      className="flex min-h-0 flex-1 flex-col gap-2.5 border-t px-3 py-2.5"
    >
      <div className="flex shrink-0 items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-xs text-subtle-foreground">
          <span className="font-medium text-muted-foreground">{selected.name}</span>
          {` · ${controls.status}`}
        </p>
        {controlled && (
          <span className="text-xs text-subtle-foreground tabular-nums">
            {leaseLeft(controls.leaseLeftMs)} left
          </span>
        )}
        <DevicesMenu devices={devices} />
      </div>
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
      {view.problem && <Problem problem={view.problem} />}
      {controls.error && <Problem problem={controls.error} />}
      {live ? (
        <>
          {/* The screen takes what the panel has left, so the whole device shows at once. */}
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
            <ControlBar>
              <ControlToggle
                inControl={controlled}
                disabled={view.pending || !controls.running}
                onToggle={toggle}
              />
            </ControlBar>
          </div>
          <DeviceKeys
            devices={devices}
            android={selected.platform === "android"}
            controlled={controlled}
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
    </section>
  );
}

/**
 * Devices (right panel): the iOS Simulators and Android emulators on the daemon's machine.
 * Enable, approve one for this thread so its agents can use it, boot, watch it live, take
 * control to tap, swipe, press keys and type, and read its logs.
 */
export function DevicesTab(props: { threadId: string }) {
  const devices = useDevices(props.threadId);
  const { view } = devices;
  if (!view.connected)
    return view.failure ? (
      <EmptyState
        icon={DeviceMobileIcon}
        title="Devices disconnected"
        description={`${view.failure.message} ${view.failure.hint}`.trim()}
        action={<Button onClick={devices.reconnect}>Reconnect</Button>}
      />
    ) : (
      <div className="grid h-full place-items-center">
        <Spinner label="Connecting to devices" />
      </div>
    );
  if (!view.enabled)
    return (
      <EmptyState
        icon={DeviceMobileIcon}
        title="Simulators and emulators"
        description="Let ace see and drive the iOS Simulators and Android emulators on this machine. Agents only reach a device you approve for their thread."
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
  const { selected, session } = view;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex max-h-[40%] shrink-0 flex-col overflow-auto">
        <div className="flex h-8 items-center justify-between px-3 pt-1">
          <h2 className="text-xs font-medium text-subtle-foreground">Devices</h2>
          {/* With no device to act on, the menu still offers to turn devices off. */}
          {!selected && <DevicesMenu devices={devices} />}
        </div>
        {view.rows.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            No simulators or emulators found on this machine.
          </p>
        ) : (
          <DeviceList rows={view.rows} selected={selected?.id} onSelect={devices.choose} />
        )}
        {view.notes.map((note) => (
          <div key={note.message} className="px-3 pb-2">
            <Problem problem={note} />
          </div>
        ))}
      </div>
      <SelectedDevice devices={devices} />
      {selected && session && (
        <div className="shrink-0">
          <DeviceLogs key={selected.id} session={session} deviceId={selected.id} />
        </div>
      )}
    </div>
  );
}
