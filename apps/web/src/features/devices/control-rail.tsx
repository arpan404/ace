import {
  ArrowUUpLeftIcon,
  CameraIcon,
  DeviceRotateIcon,
  HouseSimpleIcon,
  KeyboardIcon,
  RecordIcon,
} from "@phosphor-icons/react";
import { formatElapsed } from "@ace/ui-core";
import { useEffect, useState, type RefObject } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { railDivider } from "@/components/ui/rules.ts";
import { isEditable, useHotkey } from "@/lib/hotkeys.ts";

/** The rail's own keys, active while focus is in the device's tab and not in a field. */
export const railKeys = {
  home: "mod+shift+h",
  back: "mod+backspace",
  rotate: "mod+arrowright",
  keyboard: "mod+shift+k",
  screenshot: "mod+s",
  record: "mod+alt+r",
} as const;

/** How long a recording has run, ticking each second while it does. */
function useRecordingTime(recording: boolean): string | undefined {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const tick = () => setElapsed(Date.now() - started);
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [recording]);
  return recording ? formatElapsed(elapsed) : undefined;
}

/**
 * The floating rail on the stage's right edge: Home, Back (Android), Rotate and Keyboard while
 * you drive, then Screenshot and Record (with its running time). Each has a tooltip and a key.
 */
export function ControlRail(props: {
  /** The device's tab: the rail's keys only work while focus is inside it. */
  scope: RefObject<HTMLElement | null>;
  android: boolean;
  controlled: boolean;
  live: boolean;
  pending: boolean;
  recording: boolean;
  keyboardOpen: boolean;
  onKey(key: "home" | "back" | "rotate"): void;
  onKeyboard(): void;
  onScreenshot(): void;
  onRecord(): void;
}) {
  const time = useRecordingTime(props.recording);
  const reason = "Take control to use the device";
  const when = (event: KeyboardEvent) =>
    !isEditable(event.target) && props.scope.current?.contains(document.activeElement) === true;
  const drive = props.controlled && props.live;
  useHotkey(railKeys.home, () => props.onKey("home"), { enabled: drive, when });
  useHotkey(railKeys.back, () => props.onKey("back"), { enabled: drive && props.android, when });
  useHotkey(railKeys.rotate, () => props.onKey("rotate"), { enabled: drive, when });
  useHotkey(railKeys.keyboard, props.onKeyboard, { enabled: drive, when });
  useHotkey(railKeys.screenshot, props.onScreenshot, { enabled: props.live, when });
  useHotkey(railKeys.record, props.onRecord, { enabled: props.live, when });
  return (
    <div
      role="toolbar"
      aria-label="Device controls"
      aria-orientation="vertical"
      className="ace-floating flex flex-col items-center gap-0.5 rounded-lg p-1"
    >
      <IconButton
        icon={HouseSimpleIcon}
        label="Home"
        keys={railKeys.home}
        resolve={false}
        disabled={!drive}
        reason={props.live ? reason : undefined}
        onClick={() => props.onKey("home")}
      />
      {props.android && (
        <IconButton
          icon={ArrowUUpLeftIcon}
          label="Back"
          keys={railKeys.back}
          resolve={false}
          disabled={!drive}
          reason={props.live ? reason : undefined}
          onClick={() => props.onKey("back")}
        />
      )}
      <IconButton
        icon={DeviceRotateIcon}
        label="Rotate"
        keys={railKeys.rotate}
        resolve={false}
        disabled={!drive}
        reason={props.live ? reason : undefined}
        onClick={() => props.onKey("rotate")}
      />
      <IconButton
        icon={KeyboardIcon}
        label="Keyboard"
        keys={railKeys.keyboard}
        resolve={false}
        pressed={props.keyboardOpen}
        disabled={!drive}
        reason={props.live ? reason : undefined}
        onClick={props.onKeyboard}
      />
      <span aria-hidden className={railDivider} />
      <IconButton
        icon={CameraIcon}
        label="Screenshot"
        keys={railKeys.screenshot}
        resolve={false}
        disabled={!props.live || props.pending}
        onClick={props.onScreenshot}
      />
      <IconButton
        icon={RecordIcon}
        label={props.recording ? "Stop recording" : "Record"}
        keys={railKeys.record}
        resolve={false}
        pressed={props.recording}
        disabled={!props.live || props.pending}
        onClick={props.onRecord}
        className={props.recording ? "text-destructive aria-pressed:text-destructive" : undefined}
      />
      {time && (
        <span
          role="timer"
          aria-label="Recording time"
          className="pb-0.5 text-2xs font-medium text-destructive tabular-nums"
        >
          {time}
        </span>
      )}
    </div>
  );
}
