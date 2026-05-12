import type { ProjectScript, ProjectScriptIcon, ResolvedKeybindingsConfig } from "@ace/contracts";
import {
  BugIcon,
  ChevronDownIcon,
  FlaskConicalIcon,
  HammerIcon,
  ListChecksIcon,
  PlayIcon,
  PlusIcon,
  SettingsIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import React, { type FormEvent, type KeyboardEvent, useCallback, useMemo, useReducer } from "react";

import {
  keybindingValueForCommand,
  decodeProjectScriptKeybindingRule,
} from "~/lib/projectScriptKeybindings";
import {
  commandForProjectScript,
  nextProjectScriptId,
  primaryProjectScript,
} from "~/projectScripts";
import {
  encodeShortcutValue,
  shortcutFromKeyboardEvent,
  shortcutLabelForCommand,
} from "~/keybindings";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "./ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  HEADER_ACTION_DIALOG_FOOTER_CLASS_NAME,
  HEADER_ACTION_DIALOG_HEADER_CLASS_NAME,
  HEADER_ACTION_DIALOG_PANEL_CLASS_NAME,
  HEADER_ACTION_DIALOG_POPUP_CLASS_NAME,
  HEADER_ACTION_DIVIDER_CLASS_NAME,
  HEADER_ACTION_FIELD_CARD_CLASS_NAME,
  HEADER_ACTION_FIELD_CONTROL_CLASS_NAME,
  HEADER_ACTION_FIELD_LABEL_CLASS_NAME,
  HEADER_ACTION_GROUP_CLASS_NAME,
  HEADER_ACTION_ICON_CONTROL_CLASS_NAME,
  TopBarCluster,
} from "./thread/TopBarCluster";
import { DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME } from "~/lib/desktopChrome";

const SCRIPT_ICONS: Array<{ id: ProjectScriptIcon; label: string }> = [
  { id: "play", label: "Play" },
  { id: "test", label: "Test" },
  { id: "lint", label: "Lint" },
  { id: "configure", label: "Configure" },
  { id: "build", label: "Build" },
  { id: "debug", label: "Debug" },
];

function ScriptIcon({
  icon,
  className = "size-3.5",
}: {
  icon: ProjectScriptIcon;
  className?: string;
}) {
  if (icon === "test") return <FlaskConicalIcon className={className} />;
  if (icon === "lint") return <ListChecksIcon className={className} />;
  if (icon === "configure") return <WrenchIcon className={className} />;
  if (icon === "build") return <HammerIcon className={className} />;
  if (icon === "debug") return <BugIcon className={className} />;
  return <PlayIcon className={className} />;
}

export interface NewProjectScriptInput {
  name: string;
  command: string;
  icon: ProjectScriptIcon;
  runOnWorktreeCreate: boolean;
  keybinding: string | null;
}

interface ProjectScriptsControlProps {
  scripts: ProjectScript[];
  keybindings: ResolvedKeybindingsConfig;
  preferredScriptId?: string | null;
  onRunScript: (script: ProjectScript) => void;
  onAddScript: (input: NewProjectScriptInput) => Promise<void> | void;
  onUpdateScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void> | void;
  onDeleteScript: (scriptId: string) => Promise<void> | void;
}

type ProjectScriptDialogState = {
  editingScriptId: string | null;
  dialogOpen: boolean;
  name: string;
  command: string;
  icon: ProjectScriptIcon;
  iconPickerOpen: boolean;
  runOnWorktreeCreate: boolean;
  keybinding: string;
  validationError: string | null;
  deleteConfirmOpen: boolean;
};

type ProjectScriptDialogAction =
  | { type: "set-editing-script-id"; editingScriptId: string | null }
  | { type: "set-dialog-open"; dialogOpen: boolean }
  | { type: "set-name"; name: string }
  | { type: "set-command"; command: string }
  | { type: "set-icon"; icon: ProjectScriptIcon }
  | { type: "set-icon-picker-open"; iconPickerOpen: boolean }
  | { type: "set-run-on-worktree-create"; runOnWorktreeCreate: boolean }
  | { type: "set-keybinding"; keybinding: string }
  | { type: "set-validation-error"; validationError: string | null }
  | { type: "set-delete-confirm-open"; deleteConfirmOpen: boolean }
  | { type: "open-add-dialog" }
  | {
      type: "open-edit-dialog";
      editingScriptId: string;
      name: string;
      command: string;
      icon: ProjectScriptIcon;
      runOnWorktreeCreate: boolean;
      keybinding: string;
    }
  | { type: "close-dialog" }
  | { type: "reset-dialog-form" };

const EMPTY_PROJECT_SCRIPT_DIALOG_STATE: ProjectScriptDialogState = {
  editingScriptId: null,
  dialogOpen: false,
  name: "",
  command: "",
  icon: "play",
  iconPickerOpen: false,
  runOnWorktreeCreate: false,
  keybinding: "",
  validationError: null,
  deleteConfirmOpen: false,
};

function projectScriptDialogStateReducer(
  state: ProjectScriptDialogState,
  action: ProjectScriptDialogAction,
): ProjectScriptDialogState {
  switch (action.type) {
    case "set-editing-script-id":
      return state.editingScriptId === action.editingScriptId
        ? state
        : { ...state, editingScriptId: action.editingScriptId };
    case "set-dialog-open":
      return state.dialogOpen === action.dialogOpen
        ? state
        : { ...state, dialogOpen: action.dialogOpen };
    case "set-name":
      return state.name === action.name ? state : { ...state, name: action.name };
    case "set-command":
      return state.command === action.command ? state : { ...state, command: action.command };
    case "set-icon":
      return state.icon === action.icon ? state : { ...state, icon: action.icon };
    case "set-icon-picker-open":
      return state.iconPickerOpen === action.iconPickerOpen
        ? state
        : { ...state, iconPickerOpen: action.iconPickerOpen };
    case "set-run-on-worktree-create":
      return state.runOnWorktreeCreate === action.runOnWorktreeCreate
        ? state
        : { ...state, runOnWorktreeCreate: action.runOnWorktreeCreate };
    case "set-keybinding":
      return state.keybinding === action.keybinding
        ? state
        : { ...state, keybinding: action.keybinding };
    case "set-validation-error":
      return state.validationError === action.validationError
        ? state
        : { ...state, validationError: action.validationError };
    case "set-delete-confirm-open":
      return state.deleteConfirmOpen === action.deleteConfirmOpen
        ? state
        : { ...state, deleteConfirmOpen: action.deleteConfirmOpen };
    case "open-add-dialog":
      return {
        ...EMPTY_PROJECT_SCRIPT_DIALOG_STATE,
        dialogOpen: true,
      };
    case "open-edit-dialog":
      return {
        ...state,
        editingScriptId: action.editingScriptId,
        dialogOpen: true,
        name: action.name,
        command: action.command,
        icon: action.icon,
        iconPickerOpen: false,
        runOnWorktreeCreate: action.runOnWorktreeCreate,
        keybinding: action.keybinding,
        validationError: null,
      };
    case "close-dialog":
      return state.dialogOpen || state.iconPickerOpen
        ? { ...state, dialogOpen: false, iconPickerOpen: false }
        : state;
    case "reset-dialog-form":
      return state.editingScriptId === null &&
        state.name === "" &&
        state.command === "" &&
        state.icon === "play" &&
        state.iconPickerOpen === false &&
        state.runOnWorktreeCreate === false &&
        state.keybinding === "" &&
        state.validationError === null
        ? state
        : {
            ...state,
            editingScriptId: null,
            name: "",
            command: "",
            icon: "play",
            iconPickerOpen: false,
            runOnWorktreeCreate: false,
            keybinding: "",
            validationError: null,
          };
  }
}

export default function ProjectScriptsControl({
  scripts,
  keybindings,
  preferredScriptId = null,
  onRunScript,
  onAddScript,
  onUpdateScript,
  onDeleteScript,
}: ProjectScriptsControlProps) {
  const addScriptFormId = React.useId();
  const [dialogState, dispatchDialogState] = useReducer(
    projectScriptDialogStateReducer,
    EMPTY_PROJECT_SCRIPT_DIALOG_STATE,
  );
  const {
    editingScriptId,
    dialogOpen,
    name,
    command,
    icon,
    iconPickerOpen,
    runOnWorktreeCreate,
    keybinding,
    validationError,
    deleteConfirmOpen,
  } = dialogState;

  const primaryScript = useMemo(() => {
    if (preferredScriptId) {
      const preferred = scripts.find((script) => script.id === preferredScriptId);
      if (preferred) return preferred;
    }
    return primaryProjectScript(scripts);
  }, [preferredScriptId, scripts]);
  const isEditing = editingScriptId !== null;
  const dropdownItemClassName =
    "min-h-8 rounded-lg px-2.5 text-[13px] data-highlighted:bg-accent data-highlighted:text-foreground hover:bg-accent hover:text-foreground";

  const captureKeybinding = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") return;
    event.preventDefault();
    if (event.key === "Backspace" || event.key === "Delete") {
      dispatchDialogState({ type: "set-keybinding", keybinding: "" });
      return;
    }
    const nextShortcut = shortcutFromKeyboardEvent(event);
    if (!nextShortcut) return;
    dispatchDialogState({ type: "set-keybinding", keybinding: encodeShortcutValue(nextShortcut) });
  };

  const submitAddScript = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    if (trimmedName.length === 0) {
      dispatchDialogState({ type: "set-validation-error", validationError: "Name is required." });
      return;
    }
    if (trimmedCommand.length === 0) {
      dispatchDialogState({
        type: "set-validation-error",
        validationError: "Command is required.",
      });
      return;
    }

    dispatchDialogState({ type: "set-validation-error", validationError: null });
    try {
      const scriptIdForValidation =
        editingScriptId ??
        nextProjectScriptId(
          trimmedName,
          scripts.map((script) => script.id),
        );
      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding,
        command: commandForProjectScript(scriptIdForValidation),
      });
      const payload = {
        name: trimmedName,
        command: trimmedCommand,
        icon,
        runOnWorktreeCreate,
        keybinding: keybindingRule?.key ?? null,
      } satisfies NewProjectScriptInput;
      if (editingScriptId) {
        await onUpdateScript(editingScriptId, payload);
      } else {
        await onAddScript(payload);
      }
      dispatchDialogState({ type: "close-dialog" });
    } catch (error) {
      dispatchDialogState({
        type: "set-validation-error",
        validationError: error instanceof Error ? error.message : "Failed to save action.",
      });
    }
  };

  const openAddDialog = () => {
    dispatchDialogState({ type: "open-add-dialog" });
  };

  const openEditDialog = (script: ProjectScript) => {
    dispatchDialogState({
      type: "open-edit-dialog",
      editingScriptId: script.id,
      name: script.name,
      command: script.command,
      icon: script.icon,
      runOnWorktreeCreate: script.runOnWorktreeCreate,
      keybinding: keybindingValueForCommand(keybindings, commandForProjectScript(script.id)) ?? "",
    });
  };

  const confirmDeleteScript = useCallback(() => {
    if (!editingScriptId) return;
    dispatchDialogState({ type: "set-delete-confirm-open", deleteConfirmOpen: false });
    dispatchDialogState({ type: "close-dialog" });
    void onDeleteScript(editingScriptId);
  }, [editingScriptId, onDeleteScript]);

  return (
    <>
      {primaryScript ? (
        <TopBarCluster
          aria-label="Project scripts"
          className={`${HEADER_ACTION_GROUP_CLASS_NAME} shrink-0`}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className={HEADER_ACTION_ICON_CONTROL_CLASS_NAME}
                  onClick={() => onRunScript(primaryScript)}
                  aria-label={`Run ${primaryScript.name}`}
                />
              }
            >
              <PlayIcon className="size-4" />
            </TooltipTrigger>
            <TooltipPopup side="bottom" align="end">
              Run {primaryScript.name}
            </TooltipPopup>
          </Tooltip>
          <div className={HEADER_ACTION_DIVIDER_CLASS_NAME} aria-hidden="true" />
          <Menu highlightItemOnHover={false}>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className={HEADER_ACTION_ICON_CONTROL_CLASS_NAME}
                  aria-label="Script actions"
                />
              }
            >
              <ChevronDownIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-64 border-border/65 bg-popover/96 p-0">
              <div className="border-b border-border/40 px-2.5 py-2">
                <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  Project actions
                </div>
              </div>
              {scripts.map((script) => {
                const shortcutLabel = shortcutLabelForCommand(
                  keybindings,
                  commandForProjectScript(script.id),
                );
                return (
                  <MenuItem
                    key={script.id}
                    className={`group ${dropdownItemClassName}`}
                    onClick={() => onRunScript(script)}
                  >
                    <ScriptIcon icon={script.icon} className="size-4" />
                    <span className="truncate">
                      {script.runOnWorktreeCreate ? `${script.name} (setup)` : script.name}
                    </span>
                    <span className="relative ms-auto flex h-6 min-w-6 items-center justify-end">
                      {shortcutLabel && (
                        <MenuShortcut className="ms-0 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0">
                          {shortcutLabel}
                        </MenuShortcut>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="pointer-events-none absolute top-1/2 right-0 size-6 -translate-y-1/2 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-visible:pointer-events-auto group-focus-visible:opacity-100"
                        aria-label={`Edit ${script.name}`}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          openEditDialog(script);
                        }}
                      >
                        <SettingsIcon className="size-3.5" />
                      </Button>
                    </span>
                  </MenuItem>
                );
              })}
              <MenuItem className={dropdownItemClassName} onClick={openAddDialog}>
                <PlusIcon className="size-4" />
                Add action
              </MenuItem>
            </MenuPopup>
          </Menu>
        </TopBarCluster>
      ) : (
        <div className="flex shrink-0 items-center" aria-label="Project scripts">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-lg"
                  variant="ghost"
                  className={DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME}
                  onClick={openAddDialog}
                  aria-label="Add action"
                />
              }
            >
              <PlusIcon className="size-[18px]" />
            </TooltipTrigger>
            <TooltipPopup side="bottom" align="end">
              Add action
            </TooltipPopup>
          </Tooltip>
        </div>
      )}

      <Dialog
        onOpenChange={(open) => {
          dispatchDialogState({ type: "set-dialog-open", dialogOpen: open });
          if (!open) {
            dispatchDialogState({ type: "set-icon-picker-open", iconPickerOpen: false });
          }
        }}
        onOpenChangeComplete={(open) => {
          if (open) return;
          dispatchDialogState({ type: "reset-dialog-form" });
        }}
        open={dialogOpen}
      >
        <DialogPopup className={`${HEADER_ACTION_DIALOG_POPUP_CLASS_NAME} max-w-2xl`}>
          <DialogHeader className={HEADER_ACTION_DIALOG_HEADER_CLASS_NAME}>
            <DialogTitle>{isEditing ? "Edit action" : "Add action"}</DialogTitle>
            <DialogDescription className="max-w-xl">
              Actions are project-scoped commands you can run from the top bar or keybindings.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className={HEADER_ACTION_DIALOG_PANEL_CLASS_NAME}>
            <form id={addScriptFormId} className="space-y-4" onSubmit={submitAddScript}>
              <div className="space-y-1.5">
                <Label htmlFor="script-name" className={HEADER_ACTION_FIELD_LABEL_CLASS_NAME}>
                  Name
                </Label>
                <div className="flex items-center gap-2">
                  <Popover
                    onOpenChange={(open) =>
                      dispatchDialogState({ type: "set-icon-picker-open", iconPickerOpen: open })
                    }
                    open={iconPickerOpen}
                  >
                    <PopoverTrigger
                      render={
                        <Button
                          type="button"
                          variant="outline"
                          className="size-9 shrink-0 rounded-xl border-border/55 bg-background/72 shadow-none hover:bg-accent active:bg-accent/80 data-pressed:bg-accent"
                          aria-label="Choose icon"
                        />
                      }
                    >
                      <ScriptIcon icon={icon} className="size-4.5" />
                    </PopoverTrigger>
                    <PopoverPopup align="start" className="border-border/60 bg-popover/96 p-2">
                      <div className="grid grid-cols-3 gap-2">
                        {SCRIPT_ICONS.map((entry) => {
                          const isSelected = entry.id === icon;
                          return (
                            <button
                              key={entry.id}
                              type="button"
                              className={`relative flex flex-col items-center gap-2 rounded-lg border px-2 py-2 text-xs transition-colors ${
                                isSelected
                                  ? "border-primary/50 bg-primary/10 text-foreground"
                                  : "border-border/50 bg-background/40 text-muted-foreground hover:bg-accent hover:text-foreground"
                              }`}
                              onClick={() => {
                                dispatchDialogState({ type: "set-icon", icon: entry.id });
                                dispatchDialogState({
                                  type: "set-icon-picker-open",
                                  iconPickerOpen: false,
                                });
                              }}
                            >
                              <ScriptIcon icon={entry.id} className="size-4" />
                              <span>{entry.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </PopoverPopup>
                  </Popover>
                  <Input
                    id="script-name"
                    autoFocus
                    placeholder="Test"
                    value={name}
                    className={HEADER_ACTION_FIELD_CONTROL_CLASS_NAME}
                    onChange={(event) =>
                      dispatchDialogState({ type: "set-name", name: event.target.value })
                    }
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="script-keybinding" className={HEADER_ACTION_FIELD_LABEL_CLASS_NAME}>
                  Keybinding
                </Label>
                <div className="relative">
                  <Input
                    id="script-keybinding"
                    placeholder="Press shortcut"
                    value={keybinding}
                    className={`${HEADER_ACTION_FIELD_CONTROL_CLASS_NAME} pr-9`}
                    readOnly
                    onKeyDown={captureKeybinding}
                  />
                  {keybinding ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="absolute top-1/2 right-1 size-7 -translate-y-1/2 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                      aria-label="Clear keybinding"
                      onClick={() =>
                        dispatchDialogState({ type: "set-keybinding", keybinding: "" })
                      }
                    >
                      <XIcon className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">Press a shortcut to capture it.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="script-command" className={HEADER_ACTION_FIELD_LABEL_CLASS_NAME}>
                  Command
                </Label>
                <Textarea
                  id="script-command"
                  placeholder="bun test"
                  value={command}
                  className={`${HEADER_ACTION_FIELD_CONTROL_CLASS_NAME} min-h-28 font-mono text-[13px]`}
                  onChange={(event) =>
                    dispatchDialogState({ type: "set-command", command: event.target.value })
                  }
                />
              </div>
              <label
                className={`${HEADER_ACTION_FIELD_CARD_CLASS_NAME} flex items-center justify-between gap-3 px-3 py-2.5 text-sm`}
              >
                <span>Run automatically on worktree creation</span>
                <Switch
                  checked={runOnWorktreeCreate}
                  onCheckedChange={(checked) =>
                    dispatchDialogState({
                      type: "set-run-on-worktree-create",
                      runOnWorktreeCreate: Boolean(checked),
                    })
                  }
                />
              </label>
              {validationError && <p className="text-sm text-destructive">{validationError}</p>}
            </form>
          </DialogPanel>
          <DialogFooter className={HEADER_ACTION_DIALOG_FOOTER_CLASS_NAME}>
            {isEditing && (
              <Button
                type="button"
                variant="destructive"
                className="mr-auto"
                onClick={() =>
                  dispatchDialogState({ type: "set-delete-confirm-open", deleteConfirmOpen: true })
                }
              >
                Delete
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                dispatchDialogState({ type: "close-dialog" });
              }}
            >
              Cancel
            </Button>
            <Button form={addScriptFormId} type="submit">
              {isEditing ? "Save changes" : "Save action"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog
        open={deleteConfirmOpen}
        onOpenChange={(open) =>
          dispatchDialogState({ type: "set-delete-confirm-open", deleteConfirmOpen: open })
        }
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete action "{name}"?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={confirmDeleteScript}>
              Delete action
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
