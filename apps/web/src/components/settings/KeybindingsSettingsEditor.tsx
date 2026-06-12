import {
  type KeybindingShortcut,
  type ServerUpsertKeybindingResult,
  type StaticKeybindingCommand,
} from "@ace/contracts";
import { type KeyboardEvent, useCallback, useMemo, useReducer } from "react";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import {
  effectiveBindingForCommand,
  encodeShortcutValue,
  formatShortcutLabel,
  shortcutCollisionSignature,
  shortcutFromKeyboardEvent,
  whenExpressionFromAst,
} from "~/keybindings";
import {
  KEYBINDING_COMMAND_DEFINITIONS,
  type KeybindingCommandDefinition,
} from "~/lib/keybindingRegistry";
import { applyKeybindingsUpdated, useServerKeybindings } from "~/rpc/serverState";
import { SettingsInput, SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

type DraftShortcutByCommand = Partial<Record<StaticKeybindingCommand, KeybindingShortcut | null>>;
type DraftWhenByCommand = Partial<Record<StaticKeybindingCommand, string | undefined>>;

const CATEGORY_ORDER = [
  "Sidebar",
  "Chat",
  "Right Panel",
  "Terminal",
  "Browser",
  "Editor",
  "Threads",
] as const;
const CATEGORY_PREVIEW_COUNT = 3;
type KeybindingCategory = (typeof CATEGORY_ORDER)[number];

const CATEGORY_DESCRIPTIONS: Partial<Record<KeybindingCategory, string>> = {
  "Right Panel": "Open and focus Browser, Review, and Editor tabs in the right side panel.",
};

function shortcutRuleFingerprint(
  shortcut: KeybindingShortcut,
  platform: string,
  when: string | undefined,
): string {
  return `${shortcutCollisionSignature(shortcut, platform)}\u0000${when ?? ""}`;
}

function shortcutValueFingerprint(shortcut: KeybindingShortcut | null | undefined): string | null {
  if (!shortcut) return null;
  return encodeShortcutValue(shortcut);
}

export function KeybindingsSettingsEditor() {
  const keybindings = useServerKeybindings();
  const platform = typeof navigator === "undefined" ? "unknown" : navigator.platform;

  const initialByCommand = useMemo(() => {
    const nextShortcuts: DraftShortcutByCommand = {};
    const nextWhenByCommand: DraftWhenByCommand = {};
    for (const definition of KEYBINDING_COMMAND_DEFINITIONS) {
      const binding = effectiveBindingForCommand(
        keybindings,
        definition.command,
        definition.context ? { context: definition.context } : undefined,
      );
      nextShortcuts[definition.command] = binding?.shortcut ?? null;
      nextWhenByCommand[definition.command] = binding?.whenAst
        ? whenExpressionFromAst(binding.whenAst)
        : definition.when;
    }
    return {
      shortcuts: nextShortcuts,
      whenByCommand: nextWhenByCommand,
    };
  }, [keybindings]);
  const editorStateKey = useMemo(
    () =>
      KEYBINDING_COMMAND_DEFINITIONS.map((definition) => {
        const shortcut = shortcutValueFingerprint(initialByCommand.shortcuts[definition.command]);
        const when = initialByCommand.whenByCommand[definition.command] ?? "";
        return `${definition.command}:${shortcut ?? ""}:${when}`;
      }).join("|"),
    [initialByCommand],
  );

  return (
    <KeybindingsSettingsEditorContent
      key={editorStateKey}
      initialByCommand={initialByCommand}
      keybindings={keybindings}
      platform={platform}
    />
  );
}

type KeybindingsSettingsEditorState = {
  draftShortcuts: DraftShortcutByCommand;
  draftWhenByCommand: DraftWhenByCommand;
  expandedGroups: Partial<Record<KeybindingCategory, boolean>>;
  isSaving: boolean;
  saveError: string | null;
};

type KeybindingsSettingsEditorAction =
  | { type: "set-shortcut"; command: StaticKeybindingCommand; value: KeybindingShortcut | null }
  | { type: "toggle-group"; group: KeybindingCategory }
  | { type: "start-saving" }
  | { type: "finish-saving" }
  | { type: "set-save-error"; value: string | null }
  | {
      type: "revert";
      initialByCommand: { shortcuts: DraftShortcutByCommand; whenByCommand: DraftWhenByCommand };
    };

function createKeybindingsSettingsEditorState(initialByCommand: {
  shortcuts: DraftShortcutByCommand;
  whenByCommand: DraftWhenByCommand;
}): KeybindingsSettingsEditorState {
  return {
    draftShortcuts: initialByCommand.shortcuts,
    draftWhenByCommand: initialByCommand.whenByCommand,
    expandedGroups: {},
    isSaving: false,
    saveError: null,
  };
}

function keybindingsSettingsEditorReducer(
  state: KeybindingsSettingsEditorState,
  action: KeybindingsSettingsEditorAction,
): KeybindingsSettingsEditorState {
  switch (action.type) {
    case "set-shortcut":
      return {
        ...state,
        draftShortcuts: {
          ...state.draftShortcuts,
          [action.command]: action.value,
        },
      };
    case "toggle-group":
      return {
        ...state,
        expandedGroups: {
          ...state.expandedGroups,
          [action.group]: !state.expandedGroups[action.group],
        },
      };
    case "start-saving":
      return { ...state, isSaving: true, saveError: null };
    case "finish-saving":
      return { ...state, isSaving: false };
    case "set-save-error":
      return { ...state, saveError: action.value };
    case "revert":
      return {
        ...state,
        draftShortcuts: action.initialByCommand.shortcuts,
        draftWhenByCommand: action.initialByCommand.whenByCommand,
        saveError: null,
      };
    default:
      return state;
  }
}

function KeybindingsSettingsEditorContent(props: {
  initialByCommand: {
    shortcuts: DraftShortcutByCommand;
    whenByCommand: DraftWhenByCommand;
  };
  keybindings: ReturnType<typeof useServerKeybindings>;
  platform: string;
}) {
  const { initialByCommand, keybindings, platform } = props;
  const [state, dispatch] = useReducer(
    keybindingsSettingsEditorReducer,
    initialByCommand,
    createKeybindingsSettingsEditorState,
  );
  const { draftShortcuts, draftWhenByCommand, expandedGroups, isSaving, saveError } = state;

  const dirtyCommands = useMemo(
    () =>
      KEYBINDING_COMMAND_DEFINITIONS.filter((definition) => {
        const current = shortcutValueFingerprint(draftShortcuts[definition.command]);
        const initial = shortcutValueFingerprint(initialByCommand.shortcuts[definition.command]);
        return current !== initial;
      }),
    [draftShortcuts, initialByCommand.shortcuts],
  );

  const nonEditableShortcutFingerprints = useMemo(() => {
    const editableCommands = new Set(
      KEYBINDING_COMMAND_DEFINITIONS.map((definition) => definition.command),
    );
    const claimedByFingerprint = new Set<string>();
    const commandByFingerprint = new Map<string, string>();

    for (let index = keybindings.length - 1; index >= 0; index -= 1) {
      const binding = keybindings[index];
      if (!binding || editableCommands.has(binding.command as StaticKeybindingCommand)) continue;
      const when = binding.whenAst ? whenExpressionFromAst(binding.whenAst) : undefined;
      const fingerprint = shortcutRuleFingerprint(binding.shortcut, platform, when);
      if (claimedByFingerprint.has(fingerprint)) continue;
      claimedByFingerprint.add(fingerprint);
      commandByFingerprint.set(fingerprint, binding.command);
    }

    return commandByFingerprint;
  }, [keybindings, platform]);

  const collisionByCommand = useMemo(() => {
    const ownerByFingerprint = new Map<string, StaticKeybindingCommand>();
    const collisions = new Map<StaticKeybindingCommand, string>();

    for (const definition of KEYBINDING_COMMAND_DEFINITIONS) {
      const shortcut = draftShortcuts[definition.command];
      if (!shortcut) continue;

      const when = draftWhenByCommand[definition.command];
      const fingerprint = shortcutRuleFingerprint(shortcut, platform, when);
      const nonEditableOwner = nonEditableShortcutFingerprints.get(fingerprint);
      if (nonEditableOwner) {
        collisions.set(definition.command, `Conflicts with existing binding: ${nonEditableOwner}.`);
        continue;
      }

      const editableOwner = ownerByFingerprint.get(fingerprint);
      if (editableOwner && editableOwner !== definition.command) {
        collisions.set(definition.command, `Conflicts with ${editableOwner}.`);
        collisions.set(editableOwner, `Conflicts with ${definition.command}.`);
        continue;
      }
      ownerByFingerprint.set(fingerprint, definition.command);
    }

    return collisions;
  }, [draftShortcuts, draftWhenByCommand, nonEditableShortcutFingerprints, platform]);

  const hasUnsupportedClear = useMemo(
    () =>
      dirtyCommands.some((definition) => {
        const initialShortcut = initialByCommand.shortcuts[definition.command];
        const draftShortcut = draftShortcuts[definition.command];
        return initialShortcut && !draftShortcut;
      }),
    [dirtyCommands, draftShortcuts, initialByCommand.shortcuts],
  );

  const canSave =
    dirtyCommands.length > 0 && collisionByCommand.size === 0 && !hasUnsupportedClear && !isSaving;

  const categoryGroups = useMemo(() => {
    const groups: Array<{
      category: (typeof CATEGORY_ORDER)[number];
      items: readonly KeybindingCommandDefinition[];
    }> = [];
    for (const category of CATEGORY_ORDER) {
      const items: KeybindingCommandDefinition[] = [];
      for (const definition of KEYBINDING_COMMAND_DEFINITIONS) {
        if (definition.category === category) {
          items.push(definition);
        }
      }
      if (items.length > 0) {
        groups.push({
          category,
          items,
        });
      }
    }
    return groups;
  }, []);

  const captureShortcut = useCallback(
    (command: StaticKeybindingCommand, event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Tab") return;
      event.preventDefault();

      if (event.key === "Backspace" || event.key === "Delete") {
        dispatch({ type: "set-shortcut", command, value: null });
        return;
      }

      const shortcut = shortcutFromKeyboardEvent(event);
      if (!shortcut) return;
      dispatch({ type: "set-shortcut", command, value: shortcut });
    },
    [],
  );

  const revertChanges = useCallback(() => {
    dispatch({ type: "revert", initialByCommand });
  }, [initialByCommand.shortcuts, initialByCommand.whenByCommand]);

  const saveChanges = useCallback(async () => {
    if (!canSave) return;
    dispatch({ type: "start-saving" });
    try {
      const api = ensureNativeApi();
      const upsertPromises = dirtyCommands.flatMap((definition) => {
        const shortcut = draftShortcuts[definition.command];
        if (!shortcut) {
          return [];
        }
        const when = draftWhenByCommand[definition.command];
        return [
          api.server.upsertKeybinding({
            command: definition.command,
            key: encodeShortcutValue(shortcut),
            ...(when ? { when } : {}),
          }),
        ];
      });

      if (upsertPromises.length > 0) {
        const latestResult = (await Promise.all(upsertPromises)).at(-1);
        if (latestResult) {
          applyKeybindingsUpdated({
            keybindings: latestResult.keybindings,
            issues: latestResult.issues,
          });
        }
      }

      toastManager.add({
        type: "success",
        title: "Keybindings saved",
        description: "Keyboard shortcuts were updated.",
      });
    } catch (error) {
      dispatch({
        type: "set-save-error",
        value: error instanceof Error ? error.message : "Unable to save keybindings.",
      });
      dispatch({ type: "finish-saving" });
      return;
    }
    dispatch({ type: "finish-saving" });
  }, [canSave, dirtyCommands, draftShortcuts, draftWhenByCommand]);

  return (
    <div className="space-y-10">
      <SettingsSection title="Shortcuts">
        <SettingsRow
          title="Keyboard shortcuts"
          description="Press keys in a field to record a shortcut. Use Backspace to clear."
          control={
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={revertChanges}
                disabled={dirtyCommands.length === 0 || isSaving}
              >
                Revert
              </Button>
              <Button size="sm" onClick={() => void saveChanges()} disabled={!canSave}>
                {isSaving ? "Saving..." : "Save"}
              </Button>
            </div>
          }
        />
      </SettingsSection>

      {hasUnsupportedClear ? (
        <p className="text-sm text-destructive">
          Clearing an existing shortcut is not supported yet. Revert to keep it, or assign a new
          key.
        </p>
      ) : null}
      {saveError ? <p className="text-sm text-destructive">{saveError}</p> : null}

      {categoryGroups.map((group) => (
        <SettingsSection
          key={group.category}
          title={group.category}
          description={CATEGORY_DESCRIPTIONS[group.category]}
        >
          {(expandedGroups[group.category]
            ? group.items
            : group.items.slice(0, CATEGORY_PREVIEW_COUNT)
          ).map((definition) => {
            const shortcut = draftShortcuts[definition.command];
            const label = shortcut ? formatShortcutLabel(shortcut, platform) : "";
            const collision = collisionByCommand.get(definition.command);
            return (
              <SettingsRow
                key={definition.command}
                title={definition.label}
                description={definition.description}
                status={collision ? <span className="text-destructive">{collision}</span> : null}
                control={
                  <SettingsInput
                    value={label}
                    placeholder="Press shortcut"
                    readOnly
                    onKeyDown={(event) => captureShortcut(definition.command, event)}
                    className={cn("w-full font-mono", collision ? "border-destructive" : undefined)}
                    aria-label={`Keybinding for ${definition.label}`}
                  />
                }
              />
            );
          })}
          {group.items.length > CATEGORY_PREVIEW_COUNT ? (
            <div className="flex justify-end px-4 py-2 sm:px-5">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => dispatch({ type: "toggle-group", group: group.category })}
              >
                {expandedGroups[group.category] ? "Show less" : "Show more"}
              </Button>
            </div>
          ) : null}
        </SettingsSection>
      ))}
    </div>
  );
}
