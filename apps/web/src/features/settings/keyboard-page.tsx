import { useState, type KeyboardEvent } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { formatKeys, keymap, type KeymapId } from "@/lib/keymap.ts";
import { settingKeys } from "./data/setting-keys.ts";
import { useSetting } from "./data/use-settings.ts";
import { isRebindable } from "@/lib/keybindings.ts";
import { conflictFor, recordChord, resolveKeymap } from "./keybindings.ts";

const isApple = /Mac|iPhone|iPad/.test(globalThis.navigator?.userAgent ?? "Mac");
const ids = Object.keys(keymap) as KeymapId[];

/** Every global shortcut, with rebinding. Rebindings live in the daemon's client settings. */
export function KeyboardShortcuts() {
  const [overrides, setOverrides] = useSetting(settingKeys.keybindings);
  const [recording, setRecording] = useState<KeymapId | undefined>();
  const [problem, setProblem] = useState<{ id: KeymapId; text: string } | undefined>();
  const bindings = resolveKeymap(overrides);
  const rebound = Object.keys(overrides).filter((id) => id in keymap);

  const stop = () => setRecording(undefined);
  const save = (id: KeymapId, keys: string) => {
    const next = { ...overrides };
    if (keys === keymap[id].keys) delete next[id];
    else next[id] = keys;
    void setOverrides(next);
  };
  const onKeyDown = (id: KeymapId, event: KeyboardEvent) => {
    if (recording !== id || event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    const result = recordChord(event.nativeEvent, isApple);
    if (result.kind === "incomplete") return;
    if (result.kind === "cancel") return stop();
    if (result.kind === "needs-modifier") {
      setProblem({ id, text: `Add ${isApple ? "⌘, ⌃ or ⌥" : "Ctrl or Alt"} to the key.` });
      return;
    }
    const taken = conflictFor(result.keys, id, bindings);
    if (taken) {
      setProblem({
        id,
        text: `${formatKeys(result.keys)} is already ${keymap[taken].label}.`,
      });
      return;
    }
    setProblem(undefined);
    save(id, result.keys);
    stop();
  };

  return (
    <SettingSection label="Shortcuts">
      {ids.map((id) => {
        const active = recording === id;
        const changed = id in overrides;
        // Keys the platform or a control owns (F6, Send, terminal find) are shown, not edited.
        if (!isRebindable(id))
          return (
            <SettingRow key={id} title={keymap[id].label} description="Can't be changed">
              <Kbd keys={bindings[id]} resolve={false} className="h-5 px-2 text-[12px]" />
            </SettingRow>
          );
        return (
          <SettingRow
            key={id}
            title={keymap[id].label}
            description={
              problem?.id === id && active ? (
                <span role="alert">{problem.text}</span>
              ) : active ? (
                "Press the new shortcut. Esc cancels."
              ) : undefined
            }
          >
            {changed && !active && (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Reset ${keymap[id].label}`}
                onClick={() => save(id, keymap[id].keys)}
              >
                Reset
              </Button>
            )}
            <button
              type="button"
              aria-label={`${keymap[id].label} shortcut`}
              aria-pressed={active}
              onClick={() => {
                setProblem(undefined);
                setRecording(active ? undefined : id);
              }}
              onKeyDown={(event) => onKeyDown(id, event)}
              onBlur={() => active && stop()}
              className="rounded-sm px-1 py-0.5 outline-none transition-shadow duration-(--dur-1) hover:bg-accent focus-visible:shadow-[0_0_0_2px_color-mix(in_oklab,var(--ring)_40%,transparent)] aria-pressed:shadow-[0_0_0_2px_var(--ring)]"
            >
              {active ? (
                <Kbd className="h-5 px-2 text-[12px]">Press keys…</Kbd>
              ) : (
                <Kbd keys={bindings[id]} resolve={false} className="h-5 px-2 text-[12px]" />
              )}
            </button>
          </SettingRow>
        );
      })}
      {rebound.length > 0 && (
        <Button size="sm" variant="ghost" className="mt-3" onClick={() => void setOverrides({})}>
          Reset all shortcuts
        </Button>
      )}
    </SettingSection>
  );
}
