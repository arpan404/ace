import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { SearchField } from "@/components/search-field.tsx";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import {
  conflictFor,
  defaultKeys,
  isRebindable,
  keyboardEnv,
  normalizeKeys,
  recordChord,
  resolveKeymap,
  scopeOf,
  setKeybindingOverrides,
  useKeybindingOverrides,
  useResolvedKeymap,
  type Keybindings,
} from "@/lib/keybindings.ts";
import {
  describeKeys,
  formatKeys,
  keymap,
  keymapIds,
  parseChord,
  type KeymapId,
  type KeyScope,
} from "@/lib/keymap.ts";
import { settingKeys } from "./data/setting-keys.ts";
import { useSetting, useSettingsBackend, useSettingWrite } from "./data/use-settings.ts";

/** The page's sections, in order; an id not listed lands in "Other". */
const groups: readonly { label: string; ids: readonly KeymapId[] }[] = [
  {
    label: "General",
    ids: [
      "palette",
      "newThread",
      "newDeck",
      "addProject",
      "settings",
      "back",
      "forward",
      "toggleSidebar",
      "focusToasts",
    ],
  },
  { label: "Go to", ids: ["goHome", "goActivity", "goDeck", "goAutomations", "goSkills"] },
  {
    label: "Thread",
    ids: [
      "send",
      "findInThread",
      "turns",
      "previousTurn",
      "nextTurn",
      "renameThread",
      "pinThread",
      "archiveThread",
      "workCard",
    ],
  },
  {
    label: "Panels & tabs",
    ids: ["rightPanel", "fullView", "newTab", "closeTab", "reopenTab", "nextTab", "previousTab"],
  },
  { label: "Tools", ids: ["changes", "agents", "files", "preview", "devices", "logs"] },
  {
    label: "Terminal & browser",
    ids: ["terminal", "newTerminal", "findInTerminal", "browser", "takeControl"],
  },
  {
    label: "Activity",
    ids: [
      "activity.next",
      "activity.prev",
      "activity.open",
      "activity.approve",
      "activity.deny",
      "activity.read",
      "activity.unread",
    ],
  },
  { label: "Thread list", ids: ["home.pin", "home.select", "home.move"] },
  { label: "Deck", ids: ["deckPlan", "deckLanes", "deckApprove", "deckNextCard", "deckPrevCard"] },
];
const listed = new Set(groups.flatMap((group) => group.ids));
const sections = [
  ...groups,
  { label: "Other", ids: keymapIds.filter((id) => !listed.has(id)) },
].filter((group) => group.ids.length);

const scopeChips: Record<Exclude<KeyScope, "global">, string> = {
  home: "In the thread list",
  thread: "In a thread",
  composer: "In the composer",
  terminal: "In a terminal",
  activity: "In Activity",
  deck: "In a deck",
  notifications: "In notifications",
};

/** Chords the browser (or the system, in the app) keeps for itself; a page never sees them. */
const reserved = ["mod+w", "mod+q", "mod+t", "mod+l", "mod+r", "shift+mod+w", "shift+mod+t"];

/** Why a shortcut can't be recorded here, or undefined when it can. */
function readOnlyReason(id: KeymapId): string | undefined {
  if (!isRebindable(id)) return "Fixed";
  const keys = keymap[id].keys;
  if (keys.includes(" ")) return "Sequence";
  const chord = parseChord(keys);
  if (!chord.mod && !chord.ctrl && !chord.alt && !/^f\d+$/.test(chord.key)) return "Single key";
  return undefined;
}

type Problem =
  | { id: KeymapId; text: string }
  | { id: KeymapId; text: string; swap: { keys: string; with: KeymapId } };

/**
 * Every shortcut, grouped, with rebinding. Rebindings live in the daemon's client settings and
 * apply at once everywhere (`lib/keybindings.ts`): hotkeys, tooltips, menus and the palette.
 */
export function KeyboardShortcuts() {
  const [, store] = useSetting(settingKeys.keybindings);
  const overrides = useKeybindingOverrides();
  const bindings = useResolvedKeymap();
  const write = useSettingWrite("Keyboard shortcuts");
  const [recording, setRecording] = useState<KeymapId | undefined>();
  const [problem, setProblem] = useState<Problem | undefined>();
  const [query, setQuery] = useState("");
  const env = keyboardEnv();
  const rebound = Object.keys(overrides).length > 0;

  // The rebindings as they stand when a change runs (a Retry runs later than its click).
  const latest = useRef(overrides);
  useEffect(() => {
    latest.current = overrides;
  });
  const backend = useSettingsBackend();
  /** What the daemon holds now, as far as this window knows (its optimistic writes included). */
  const authoritative = (): Keybindings => {
    const parsed = settingKeys.keybindings.schema.safeParse(
      backend.values.get()[settingKeys.keybindings.key],
    );
    return parsed.success ? parsed.data : {};
  };
  /**
   * Apply an edit to the rebindings: shown at once, then stored. A Retry re-applies the edit to
   * what is current then, never an old snapshot; a refusal shows what the daemon holds, so a
   * failed older edit can't undo a newer one that was accepted.
   */
  const change = (edit: (current: Keybindings) => Keybindings) =>
    write.run(async () => {
      const clean: Record<string, string> = {};
      for (const [id, keys] of Object.entries(edit(latest.current)))
        if (normalizeKeys(keys) !== normalizeKeys(defaultKeys(id as KeymapId))) clean[id] = keys;
      latest.current = clean;
      setKeybindingOverrides(clean);
      try {
        await store(clean);
      } catch (error) {
        setKeybindingOverrides(authoritative());
        throw error;
      }
    });
  const bind = (id: KeymapId, keys: string) => change((current) => ({ ...current, [id]: keys }));
  const stop = () => setRecording(undefined);

  const onKeyDown = (id: KeymapId, event: KeyboardEvent) => {
    if (recording !== id || event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    const result = recordChord(event.nativeEvent, env.apple);
    if (result.kind === "incomplete") return;
    if (result.kind === "cancel") return stop();
    if (result.kind === "needs-modifier") {
      setProblem({ id, text: `Add ${env.apple ? "⌘, ⌃ or ⌥" : "Ctrl or Alt"} to the key.` });
      return;
    }
    const keys = result.keys;
    if (reserved.some((chord) => normalizeKeys(chord) === normalizeKeys(keys))) {
      setProblem({
        id,
        text: `${formatKeys(keys)} is used by ${env.web ? "the browser" : "the system"}.`,
      });
      return;
    }
    const taken = conflictFor(keys, id, bindings);
    if (taken) {
      // Swapping hands the other shortcut these keys' old binding, if that fits where it works.
      const swapped = resolveKeymap({ ...overrides, [id]: keys, [taken]: bindings[id] });
      const fits = isRebindable(taken) && !conflictFor(bindings[id], taken, swapped);
      setProblem({
        id,
        text: `${formatKeys(keys)} is already ${keymap[taken].label}.`,
        ...(fits ? { swap: { keys, with: taken } } : {}),
      });
      return;
    }
    setProblem(undefined);
    bind(id, keys);
    stop();
  };

  const text = query.trim().toLowerCase();
  const shown = (id: KeymapId) =>
    !text ||
    keymap[id].label.toLowerCase().includes(text) ||
    formatKeys(bindings[id]).toLowerCase().includes(text) ||
    describeKeys(bindings[id]).toLowerCase().includes(text);
  const visible = sections
    .map((section) => ({ section, ids: section.ids.filter(shown) }))
    .filter((entry) => entry.ids.length);

  return (
    <div id="keyboard.shortcuts">
      <div className="mt-6 flex items-center gap-3">
        <SearchField
          label="Filter shortcuts"
          placeholder="Filter by name or keys"
          value={query}
          onValueChange={setQuery}
          className="max-w-80"
        />
        {rebound && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => change(() => ({}))}>
            Reset all shortcuts
          </Button>
        )}
      </div>
      {!visible.length && (
        <EmptyState
          variant="inline"
          className="px-0"
          title={`No shortcut matches "${query.trim()}".`}
        />
      )}
      {visible.map(({ section, ids }) => (
        <SettingSection key={section.label} label={section.label} card scope="daemon">
          {ids.map((id) => (
            <ShortcutRow
              key={id}
              id={id}
              keys={bindings[id]}
              changed={id in overrides}
              recording={recording === id}
              problem={problem?.id === id ? problem : undefined}
              onRecord={(on) => {
                setProblem(undefined);
                setRecording(on ? id : undefined);
              }}
              onKeyDown={(event) => onKeyDown(id, event)}
              onBlur={() => recording === id && stop()}
              onReset={() =>
                change((current) => {
                  const next = { ...current };
                  delete next[id];
                  return next;
                })
              }
              onSwap={(swap) => {
                const previous = bindings[id];
                change((current) => ({ ...current, [id]: swap.keys, [swap.with]: previous }));
                setProblem(undefined);
                stop();
              }}
            />
          ))}
        </SettingSection>
      ))}
    </div>
  );
}

function ShortcutRow(props: {
  id: KeymapId;
  keys: string;
  changed: boolean;
  recording: boolean;
  problem: Problem | undefined;
  onRecord(on: boolean): void;
  onKeyDown(event: KeyboardEvent): void;
  onBlur(): void;
  onReset(): void;
  onSwap(swap: { keys: string; with: KeymapId }): void;
}) {
  const { id, keys, recording, problem } = props;
  const label = keymap[id].label;
  const described = useId();
  const scope = scopeOf(id);
  const readOnly = readOnlyReason(id);
  const swap = problem && "swap" in problem ? problem.swap : undefined;
  return (
    <SettingRow
      title={
        <span className="inline-flex items-center gap-1.5">
          {label}
          {props.changed && (
            <span
              role="img"
              aria-label="Changed"
              className="inline-block size-1.5 rounded-full bg-ring"
            />
          )}
        </span>
      }
      description={
        problem && recording ? (
          <span role="alert">{problem.text}</span>
        ) : recording ? (
          "Press the new shortcut. Esc cancels."
        ) : (
          [
            // Keys the platform or a control owns (F6, Send, terminal find): shown, not edited.
            readOnly === "Fixed" && "Can't be changed",
            scope !== "global" && scopeChips[scope],
          ]
            .filter(Boolean)
            .join(" · ") || undefined
        )
      }
      inline
    >
      <span
        className="flex items-center gap-2"
        // Recording ends when focus leaves the row's controls, not when it moves to Use anyway.
        onBlur={(event) => {
          if (
            !(
              event.relatedTarget instanceof Node &&
              event.currentTarget.contains(event.relatedTarget)
            )
          )
            props.onBlur();
        }}
      >
        {swap && recording && (
          <Button size="sm" variant="ghost" onClick={() => props.onSwap(swap)}>
            Use anyway
          </Button>
        )}
        {props.changed && !recording && (
          <Button size="sm" variant="ghost" aria-label={`Reset ${label}`} onClick={props.onReset}>
            Reset
          </Button>
        )}
        {readOnly ? (
          <span className="inline-flex items-center gap-2">
            {readOnly !== "Fixed" && (
              <span className="text-xs text-muted-foreground">{readOnly}</span>
            )}
            <Kbd keys={keys} resolve={false} className="h-5 px-2 text-sm" />
          </span>
        ) : (
          <span id={described} hidden>
            {`${describeKeys(keys)}. Press to change.`}
          </span>
        )}
        {!readOnly && (
          <button
            type="button"
            aria-label={`${label} shortcut`}
            aria-describedby={described}
            aria-pressed={recording}
            onClick={() => props.onRecord(!recording)}
            onKeyDown={props.onKeyDown}
            className="rounded-sm px-1 py-0.5 transition-shadow duration-(--dur-1) hover:bg-accent focus-ring aria-pressed:bg-accent"
          >
            {recording ? (
              <Kbd className="h-5 px-2 text-sm">Press keys…</Kbd>
            ) : (
              <Kbd keys={keys} resolve={false} className="h-5 px-2 text-sm" />
            )}
          </button>
        )}
      </span>
    </SettingRow>
  );
}
