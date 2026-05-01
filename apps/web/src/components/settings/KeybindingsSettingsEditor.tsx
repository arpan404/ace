import {
  type KeybindingShortcut,
  type ServerUpsertKeybindingResult,
  type StaticKeybindingCommand,
} from "@ace/contracts";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useState } from "react";
import { ensureNativeApi } from "~/nativeApi";
import {
  effectiveBindingForCommand,
  encodeShortcutValue,
  formatShortcutLabel,
  shortcutCollisionSignature,
  shortcutFromKeyboardEvent,
  whenExpressionFromAst,
} from "~/keybindings";
import { KEYBINDING_COMMAND_DEFINITIONS } from "~/lib/keybindingRegistry";
import { applyKeybindingsUpdated, useServerKeybindings } from "~/rpc/serverState";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
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
  const [draftShortcuts, setDraftShortcuts] = useState<DraftShortcutByCommand>({});
  const [draftWhenByCommand, setDraftWhenByCommand] = useState<DraftWhenByCommand>({});
  const [expandedGroups, setExpandedGroups] = useState<
    Partial<Record<KeybindingCategory, boolean>>
  >({});
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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

  useEffect(() => {
    setDraftShortcuts(initialByCommand.shortcuts);
    setDraftWhenByCommand(initialByCommand.whenByCommand);
    setSaveError(null);
  }, [initialByCommand]);

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
    return CATEGORY_ORDER.map((category) => ({
      category,
      items: KEYBINDING_COMMAND_DEFINITIONS.filter(
        (definition) => definition.category === category,
      ),
    })).filter((group) => group.items.length > 0);
  }, []);

  const captureShortcut = useCallback(
    (command: StaticKeybindingCommand, event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Tab") return;
      event.preventDefault();

      if (event.key === "Backspace" || event.key === "Delete") {
        setDraftShortcuts((previous) => ({ ...previous, [command]: null }));
        return;
      }

      const shortcut = shortcutFromKeyboardEvent(event);
      if (!shortcut) return;
      setDraftShortcuts((previous) => ({ ...previous, [command]: shortcut }));
    },
    [],
  );

  const revertChanges = useCallback(() => {
    setDraftShortcuts(initialByCommand.shortcuts);
    setDraftWhenByCommand(initialByCommand.whenByCommand);
    setSaveError(null);
  }, [initialByCommand.shortcuts, initialByCommand.whenByCommand]);

  const saveChanges = useCallback(async () => {
    if (!canSave) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      const api = ensureNativeApi();
      let latestResult: ServerUpsertKeybindingResult | null = null;

      for (const definition of dirtyCommands) {
        const shortcut = draftShortcuts[definition.command];
        if (!shortcut) {
          continue;
        }
        const when = draftWhenByCommand[definition.command];
        latestResult = await api.server.upsertKeybinding({
          command: definition.command,
          key: encodeShortcutValue(shortcut),
          ...(when ? { when } : {}),
        });
      }

      if (latestResult) {
        applyKeybindingsUpdated({
          keybindings: latestResult.keybindings,
          issues: latestResult.issues,
        });
      }

      toastManager.add({
        type: "success",
        title: "Keybindings saved",
        description: "Keyboard shortcuts were updated.",
      });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Unable to save keybindings.");
    } finally {
      setIsSaving(false);
    }
  }, [canSave, dirtyCommands, draftShortcuts, draftWhenByCommand]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[12px] text-muted-foreground/70">
          Press keys inside an input to record a shortcut. Use <code>Backspace</code> to clear.
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            onClick={revertChanges}
            disabled={dirtyCommands.length === 0 || isSaving}
          >
            Revert
          </Button>
          <Button size="xs" onClick={() => void saveChanges()} disabled={!canSave}>
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      {hasUnsupportedClear ? (
        <p className="text-xs text-destructive">
          Clearing an existing shortcut is not supported yet. Revert to keep it, or assign a new
          key.
        </p>
      ) : null}
      {saveError ? <p className="text-xs text-destructive">{saveError}</p> : null}

      {categoryGroups.map((group) => (
        <section key={group.category} className="space-y-1.5">
          <div className="space-y-0.5 px-0.5">
            <h4 className="text-[10px] font-semibold tracking-[0.14em] text-muted-foreground/72 uppercase">
              {group.category}
            </h4>
            {CATEGORY_DESCRIPTIONS[group.category] ? (
              <p className="text-[12px] text-muted-foreground/65">
                {CATEGORY_DESCRIPTIONS[group.category]}
              </p>
            ) : null}
          </div>
          <div className="overflow-hidden rounded-[var(--panel-radius)] border border-border/50 bg-background/30">
            {(expandedGroups[group.category]
              ? group.items
              : group.items.slice(0, CATEGORY_PREVIEW_COUNT)
            ).map((definition) => {
              const shortcut = draftShortcuts[definition.command];
              const label = shortcut ? formatShortcutLabel(shortcut, platform) : "";
              const collision = collisionByCommand.get(definition.command);
              return (
                <div
                  key={definition.command}
                  className="grid gap-2 border-t border-border/40 px-3 py-2.5 first:border-t-0 md:grid-cols-[minmax(0,1fr)_200px] md:items-center"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-foreground/90">
                      {definition.label}
                    </p>
                    <p className="text-[12px] text-muted-foreground/65">{definition.description}</p>
                    {collision ? (
                      <p className="mt-0.5 text-xs text-destructive">{collision}</p>
                    ) : null}
                  </div>
                  <Input
                    value={label}
                    placeholder="Press shortcut"
                    readOnly
                    onKeyDown={(event) => captureShortcut(definition.command, event)}
                    className={collision ? "border-destructive/70" : undefined}
                    aria-label={`Keybinding for ${definition.label}`}
                  />
                </div>
              );
            })}
            {group.items.length > CATEGORY_PREVIEW_COUNT ? (
              <div className="flex justify-end border-t border-border/40 px-3 py-2">
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    setExpandedGroups((previous) => ({
                      ...previous,
                      [group.category]: !previous[group.category],
                    }))
                  }
                >
                  {expandedGroups[group.category] ? "Show less" : "Show more"}
                </Button>
              </div>
            ) : null}
          </div>
        </section>
      ))}
    </div>
  );
}
