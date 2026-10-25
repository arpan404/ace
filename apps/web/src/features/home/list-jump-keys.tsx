import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useHotkey } from "@/lib/hotkeys.ts";
import { bindingsFor, keyboardEnv, useResolvedKeymap } from "@/lib/keybindings.ts";
import { threadOn } from "@/lib/machine-routes.ts";
import { machineRow } from "@/lib/machine-threads.ts";
import { holdsJumpModifiers, jumpChords } from "./list-jump.ts";

/** How long the modifiers are held before the rows show their numbers. */
export const jumpHintDelayMs = 300;

function JumpKey(props: { keys: string; onPress(): void }) {
  useHotkey(props.keys, props.onPress);
  return null;
}

/**
 * ⌘1 to ⌘9 (⌥⌘1 to ⌥⌘9 in a browser tab, which keeps ⌘1–9) open the list's first nine threads.
 * A picker with its own ⌘1–9 (the model picker) takes the key first: it handles it on its
 * element and marks it handled, and hotkeys skip handled keys.
 */
export function JumpKeys(props: { targets: readonly string[] }) {
  const navigate = useNavigate();
  const resolved = useResolvedKeymap();
  const chords = bindingsFor("jumpToThread", resolved).flatMap((first) =>
    jumpChords(first).map((keys, index) => ({ keys, index })),
  );
  return chords.map(({ keys, index }) => (
    <JumpKey
      key={keys}
      keys={keys}
      onPress={() => {
        const id = props.targets[index];
        if (!id) return;
        // Another machine's row opens its thread on that machine.
        const other = machineRow(id);
        void navigate(other ? threadOn(other.hostId, other.threadId) : threadOn(undefined, id));
      }}
    />
  ));
}

/** Whether the jump modifiers have been held, alone, long enough to show the rows' numbers. */
export function useJumpHints(): boolean {
  const first = useResolvedKeymap().jumpToThread;
  const [shown, setShown] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hide = () => {
      clearTimeout(timer);
      timer = undefined;
      setShown(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!holdsJumpModifiers(event, first, keyboardEnv().apple)) return hide();
      if (timer === undefined) timer = setTimeout(() => setShown(true), jumpHintDelayMs);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, [first]);
  return shown;
}
