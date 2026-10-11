import { XIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { keyboardEnv, recordChord } from "@/lib/keybindings.ts";
import { desktopAccelerator, desktopShortcutLabel } from "@/lib/desktop-shortcut.ts";

export function DesktopShortcut(props: {
  value: string | null;
  onChange(value: string | null): void;
}) {
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        aria-label="Quick-thread global shortcut"
        onClick={() => {
          setRecording(true);
          setProblem(false);
        }}
        onBlur={() => setRecording(false)}
        onKeyDown={(event) => {
          if (!recording) return;
          event.preventDefault();
          event.stopPropagation();
          const result = recordChord(event.nativeEvent, keyboardEnv().apple);
          if (result.kind === "cancel") setRecording(false);
          if (result.kind === "needs-modifier") setProblem(true);
          if (result.kind === "chord") {
            props.onChange(desktopAccelerator(result.keys));
            setRecording(false);
            setProblem(false);
          }
        }}
      >
        {recording ? "Press a shortcut…" : desktopShortcutLabel(props.value)}
      </Button>
      {props.value && (
        <IconButton
          icon={XIcon}
          label="Turn off global shortcut"
          size="sm"
          onClick={() => props.onChange(null)}
        />
      )}
      {problem && (
        <span role="alert" className="text-sm text-status-failed">
          Include Command, Control or Alt.
        </span>
      )}
    </>
  );
}
