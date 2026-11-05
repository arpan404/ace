import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { SearchField } from "@/components/search-field.tsx";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { RowMenu } from "@/components/ui/row-menu.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
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
  systemKeys,
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
import { useDeviceKeymap } from "@/lib/device-keymap.ts";
import { useSettingWrite } from "./data/use-settings.ts";
import { GlobalShortcuts } from "./keyboard-global.tsx";

/** The page's sections, in order; an id not listed lands in "Other". */
const groups: readonly { label: string; ids: readonly KeymapId[] }[] = [
  {
    label: "General",
    ids: [
      "palette",
      "newThread",
      "newThreadHere",
      "addProject",
      "settings",
      "reloadApp",
      "back",
      "forward",
      "toggleSidebar",
      "undo",
      "contextMenu",
    ],
  },
  {
    label: "Focus",
    ids: ["nextRegion", "previousRegion", "focusThreadList", "focusComposer", "focusToasts"],
  },
  {
    label: "Go to",
    ids: [
      "goHome",
      "goChats",
      "goAutomations",
      "goSkills",
      "goUsage",
      "goPullRequests",
      "goIssues",
      "nextThread",
      "previousThread",
      "nextNeedsYou",
      "jumpToThread",
    ],
  },
  {
    label: "Thread",
    ids: [
      "followUpOther",
      "startInBackground",
      "stopAgent",
      "stopFromComposer",
      "reorderQueued",
      "findInThread",
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
    ids: [
      "rightPanel",
      "fullView",
      "newTab",
      "closeTab",
      "reopenTab",
      "nextTab",
      "previousTab",
      "panel.closeTab",
      "panel.moveTab",
    ],
  },
  { label: "File tree", ids: ["files.rename", "files.delete", "files.move"] },
  { label: "Tools", ids: ["changes", "agents", "files", "preview", "devices", "logs"] },
  {
    label: "Terminal & browser",
    ids: ["terminal", "terminalPanel", "newTerminal", "findInTerminal", "browser"],
  },
  {
    label: "Threads",
    ids: ["showInbox", "showSnoozed", "showSettled", "nextThreadsTab"],
  },
  {
    label: "Thread list",
    ids: [
      "home.pin",
      "home.select",
      "home.settle",
      "home.snooze",
      "home.tabs",
      "home.move",
      "home.actions",
      "home.range",
      "home.ends",
    ],
  },
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
  newThread: "On New thread",
  panel: "On a side panel tab",
  files: "In the file tree",
  terminal: "In a terminal",
  notifications: "In notifications",
};

/** Chords a browser tab keeps for itself; a page never sees them. */
function browserKeys(): readonly string[] {
  if (!keyboardEnv().web) return [];
  return [
    "mod+w",
    "mod+q",
    "mod+t",
    "mod+l",
    "mod+r",
    "mod+n",
    "shift+mod+n",
    "shift+mod+w",
    "shift+mod+t",
  ];
}

/** Who keeps `keys` for itself, or undefined when a shortcut may have them. */
function reservedBy(keys: string): string | undefined {
  const same = (chord: string) => normalizeKeys(chord) === normalizeKeys(keys);
  if (browserKeys().some(same)) return "the browser";
  if (systemKeys().some(same)) return "the system";
  return undefined;
}

/** Why a shortcut can't be recorded here, or undefined when it can. */
function readOnlyReason(id: KeymapId): string | undefined {
  if (!isRebindable(id)) return "Fixed";
  const chord = parseChord(keymap[id].keys);
  if (!chord.mod && !chord.ctrl && !chord.alt && !/^f\d+$/.test(chord.key)) return "Single key";
  return undefined;
}

type Problem =
  | { id: KeymapId; text: string }
  | { id: KeymapId; text: string; swap: { keys: string; with: KeymapId } };

/**
 * Every shortcut, grouped, with rebinding. Rebindings belong to this device (each app and browser
 * keeps its own) and apply at once across it (`lib/keybindings.ts`): hotkeys, tooltips, menus and
 * the palette.
 */
export function KeyboardShortcuts() {
  const device = useDeviceKeymap();
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
  /**
   * Apply an edit to the rebindings: shown at once, then stored on this device. A Retry re-applies
   * the edit to what is current then, never an old snapshot; a failed save shows what the device
   * holds, so a failed older edit can't undo a newer one that was saved.
   */
  const change = (edit: (current: Keybindings) => Keybindings) =>
    write.run(async () => {
      const clean: Record<string, string> = {};
      for (const [id, keys] of Object.entries(edit(latest.current)))
        if (normalizeKeys(keys) !== normalizeKeys(defaultKeys(id as KeymapId))) clean[id] = keys;
      latest.current = clean;
      setKeybindingOverrides(clean);
      try {
        await device.set(clean);
      } catch (error) {
        setKeybindingOverrides(device.get() ?? {});
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
    // A shortcut may always take back its own default (Reload's ⌘R).
    const ownDefault = normalizeKeys(keys) === normalizeKeys(defaultKeys(id));
    const reserved = ownDefault ? undefined : reservedBy(keys);
    if (reserved) {
      setProblem({ id, text: `${formatKeys(keys)} is used by ${reserved}.` });
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
      <GlobalShortcuts />
      {/* The filter sits in the title band; the first group starts a clear step below it. */}
      <div className="mb-6 flex items-center gap-3">
        <SearchField
          label="Filter shortcuts"
          placeholder="Search shortcuts"
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
        <SettingSection key={section.label} label={section.label} card>
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
        ) : undefined
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
          <RowMenu label={`Actions for ${label}`}>
            <MenuItem onClick={props.onReset}>Reset</MenuItem>
          </RowMenu>
        )}
        {readOnly ? (
          <Tip
            label={[
              readOnly === "Fixed"
                ? "Can't be changed"
                : readOnly === "Sequence"
                  ? "Press these keys in order"
                  : "Single key",
              scope !== "global" && scopeChips[scope],
            ]
              .filter(Boolean)
              .join(" · ")}
          >
            <span
              // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable so its tooltip reaches the keyboard
              tabIndex={0}
              aria-label={`${label} shortcut`}
              aria-disabled
              className="rounded-sm focus-ring"
            >
              <Kbd keys={keys} resolve={false} separate className="h-5 px-2 text-sm" />
            </span>
          </Tip>
        ) : (
          <span id={described} hidden>{`${describeKeys(keys)}. Press to change.`}</span>
        )}
        {!readOnly && (
          <button
            type="button"
            aria-label={`${label} shortcut`}
            aria-describedby={described}
            aria-pressed={recording}
            onClick={() => props.onRecord(!recording)}
            onKeyDown={props.onKeyDown}
            className="rounded-sm px-1 py-0.5 transition-shadow duration-(--motion-fast) hover:bg-accent focus-ring aria-pressed:bg-accent"
          >
            {recording ? (
              <Kbd className="h-5 px-2 text-sm">Press keys…</Kbd>
            ) : (
              <Kbd keys={keys} resolve={false} separate className="h-5 px-2 text-sm" />
            )}
          </button>
        )}
      </span>
    </SettingRow>
  );
}
