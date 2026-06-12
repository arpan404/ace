import type { ProjectScript, ProjectScriptIcon, ResolvedKeybindingsConfig } from "@ace/contracts";
import {
  BugIcon,
  FlaskConicalIcon,
  HammerIcon,
  ListChecksIcon,
  PlayIcon,
  PlusIcon,
  SettingsIcon,
  TerminalIcon,
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
  formatProjectScriptEnv,
  nextProjectScriptId,
  parseProjectScriptEnv,
  primaryProjectScript,
} from "~/projectScripts";
import {
  encodeShortcutValue,
  shortcutFromKeyboardEvent,
  shortcutLabelForCommand,
} from "~/keybindings";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
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
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  HEADER_ACTION_DIALOG_POPUP_CLASS_NAME,
  HEADER_ACTION_FIELD_CONTROL_CLASS_NAME,
  HEADER_ACTION_FIELD_LABEL_CLASS_NAME,
} from "./thread/topBarClusterStyles";

const SCRIPT_ICONS: Array<{ id: ProjectScriptIcon; label: string }> = [
  { id: "play", label: "Run" },
  { id: "test", label: "Test" },
  { id: "lint", label: "Lint" },
  { id: "configure", label: "Setup" },
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
  return <TerminalIcon className={className} />;
}

export interface NewProjectScriptInput {
  name: string;
  command: string;
  icon: ProjectScriptIcon;
  runOnWorktreeCreate: boolean;
  env: Record<string, string>;
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
  runOnWorktreeCreate: boolean;
  env: string;
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
  | { type: "set-run-on-worktree-create"; runOnWorktreeCreate: boolean }
  | { type: "set-env"; env: string }
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
      env: string;
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
  runOnWorktreeCreate: false,
  env: "",
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
    case "set-run-on-worktree-create":
      return state.runOnWorktreeCreate === action.runOnWorktreeCreate
        ? state
        : { ...state, runOnWorktreeCreate: action.runOnWorktreeCreate };
    case "set-env":
      return state.env === action.env ? state : { ...state, env: action.env };
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
        runOnWorktreeCreate: action.runOnWorktreeCreate,
        env: action.env,
        keybinding: action.keybinding,
        validationError: null,
      };
    case "close-dialog":
      return state.dialogOpen ? { ...state, dialogOpen: false } : state;
    case "reset-dialog-form":
      return state.editingScriptId === null &&
        state.name === "" &&
        state.command === "" &&
        state.icon === "play" &&
        state.runOnWorktreeCreate === false &&
        state.env === "" &&
        state.keybinding === "" &&
        state.validationError === null
        ? state
        : {
            ...state,
            editingScriptId: null,
            name: "",
            command: "",
            icon: "play",
            runOnWorktreeCreate: false,
            env: "",
            keybinding: "",
            validationError: null,
          };
  }
}

function ProjectScriptEditorDialog(props: {
  addScriptFormId: string;
  captureKeybinding: (event: KeyboardEvent<HTMLInputElement>) => void;
  command: string;
  confirmDeleteScript: () => void;
  deleteConfirmOpen: boolean;
  dialogOpen: boolean;
  dispatchDialogState: React.Dispatch<ProjectScriptDialogAction>;
  icon: ProjectScriptIcon;
  isEditing: boolean;
  keybinding: string;
  name: string;
  runOnWorktreeCreate: boolean;
  env: string;
  submitAddScript: (event: FormEvent) => Promise<void>;
  validationError: string | null;
}) {
  return (
    <>
      <Dialog
        disablePointerDismissal
        onOpenChange={(open, eventDetails) => {
          if (
            !open &&
            (eventDetails.reason === "outside-press" || eventDetails.reason === "focus-out")
          ) {
            return;
          }
          props.dispatchDialogState({ type: "set-dialog-open", dialogOpen: open });
        }}
        onOpenChangeComplete={(open) => {
          if (open) return;
          props.dispatchDialogState({ type: "reset-dialog-form" });
        }}
        open={props.dialogOpen}
      >
        <DialogPopup
          className={`${HEADER_ACTION_DIALOG_POPUP_CLASS_NAME} w-[min(44rem,calc(100vw-1.5rem))] max-w-none`}
        >
          <DialogHeader className="border-b border-border/35 px-4 py-3 sm:px-5">
            <DialogTitle className="text-[17px] leading-6">
              {props.isEditing ? "Edit action" : "Add action"}
            </DialogTitle>
            <DialogDescription className="text-[13px] leading-5 text-muted-foreground/70">
              Project command available from the environment panel and shortcuts.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="px-4 py-3.5 sm:px-5">
            <form
              id={props.addScriptFormId}
              className="divide-y divide-border/30"
              onSubmit={props.submitAddScript}
            >
              <div className="grid gap-3 pb-4 sm:grid-cols-[minmax(0,1fr)_16rem]">
                <label className="space-y-1.5">
                  <span className={HEADER_ACTION_FIELD_LABEL_CLASS_NAME}>Name</span>
                  <Input
                    id="script-name"
                    placeholder="Test"
                    value={props.name}
                    className={HEADER_ACTION_FIELD_CONTROL_CLASS_NAME}
                    onChange={(event) =>
                      props.dispatchDialogState({ type: "set-name", name: event.target.value })
                    }
                  />
                </label>
                <div className="space-y-1.5">
                  <Label
                    htmlFor="script-keybinding"
                    className={HEADER_ACTION_FIELD_LABEL_CLASS_NAME}
                  >
                    Keybinding
                  </Label>
                  <div className="relative">
                    <Input
                      id="script-keybinding"
                      placeholder="Press shortcut"
                      value={props.keybinding}
                      className={`${HEADER_ACTION_FIELD_CONTROL_CLASS_NAME} pr-9`}
                      readOnly
                      onKeyDown={props.captureKeybinding}
                    />
                    {props.keybinding ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="absolute top-1/2 right-1 size-7 -translate-y-1/2 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                        aria-label="Clear keybinding"
                        onClick={() =>
                          props.dispatchDialogState({ type: "set-keybinding", keybinding: "" })
                        }
                      >
                        <XIcon className="size-3.5" />
                      </Button>
                    ) : null}
                  </div>
                </div>
                <fieldset className="space-y-2 sm:col-span-2">
                  <legend className={HEADER_ACTION_FIELD_LABEL_CLASS_NAME}>Type</legend>
                  <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
                    {SCRIPT_ICONS.map((entry) => {
                      const isSelected = entry.id === props.icon;
                      return (
                        <button
                          key={entry.id}
                          type="button"
                          className={`group flex h-9 items-center justify-center gap-1.5 rounded-[var(--control-radius)] border px-2 text-[12px] transition-colors ${
                            isSelected
                              ? "border-foreground/18 bg-foreground/[0.08] text-foreground"
                              : "border-border/35 bg-transparent text-muted-foreground/78 hover:border-border/55 hover:bg-foreground/[0.045] hover:text-foreground"
                          }`}
                          aria-pressed={isSelected}
                          onClick={() =>
                            props.dispatchDialogState({ type: "set-icon", icon: entry.id })
                          }
                        >
                          <ScriptIcon
                            icon={entry.id}
                            className={`size-3.5 ${
                              isSelected
                                ? "text-foreground"
                                : "text-muted-foreground/70 group-hover:text-foreground"
                            }`}
                          />
                          <span className="truncate">{entry.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </fieldset>
              </div>
              <div className="space-y-3 py-4">
                <div className="grid gap-2">
                  <Label htmlFor="script-command" className={HEADER_ACTION_FIELD_LABEL_CLASS_NAME}>
                    Command
                  </Label>
                  <Textarea
                    id="script-command"
                    placeholder="bun test"
                    value={props.command}
                    className={`${HEADER_ACTION_FIELD_CONTROL_CLASS_NAME} min-h-24 font-mono text-[13px] leading-5`}
                    onChange={(event) =>
                      props.dispatchDialogState({
                        type: "set-command",
                        command: event.target.value,
                      })
                    }
                  />
                </div>
                <div className="flex min-h-9 items-center justify-between gap-3 rounded-[var(--control-radius)] border border-border/35 bg-foreground/[0.025] px-3 text-[13px]">
                  <Label htmlFor="script-run-on-worktree-create" className="text-foreground/84">
                    Run after creating a worktree
                  </Label>
                  <Switch
                    id="script-run-on-worktree-create"
                    checked={props.runOnWorktreeCreate}
                    onCheckedChange={(checked) =>
                      props.dispatchDialogState({
                        type: "set-run-on-worktree-create",
                        runOnWorktreeCreate: Boolean(checked),
                      })
                    }
                  />
                </div>
              </div>
              <div className="space-y-1.5 pt-4">
                <div className="flex items-end justify-between gap-3">
                  <Label htmlFor="script-env" className={HEADER_ACTION_FIELD_LABEL_CLASS_NAME}>
                    Environment
                  </Label>
                  <span className="text-[11px] text-muted-foreground/64">KEY=value</span>
                </div>
                <Textarea
                  id="script-env"
                  placeholder={"NODE_ENV=development\nAPI_BASE_URL=http://localhost:3000"}
                  value={props.env}
                  className={`${HEADER_ACTION_FIELD_CONTROL_CLASS_NAME} min-h-20 font-mono text-[13px] leading-5`}
                  onChange={(event) =>
                    props.dispatchDialogState({ type: "set-env", env: event.target.value })
                  }
                />
                <p className="text-[12px] text-muted-foreground/68">
                  Optional variables passed only to this action.
                </p>
                {props.validationError && (
                  <p className="rounded-md border border-destructive/25 bg-destructive/8 px-3 py-2 text-[13px] text-destructive">
                    {props.validationError}
                  </p>
                )}
              </div>
            </form>
          </DialogPanel>
          <DialogFooter className="border-t border-border/40 bg-background/36 px-4 py-3 sm:px-5">
            {props.isEditing && (
              <Button
                type="button"
                variant="destructive"
                className="mr-auto"
                onClick={() =>
                  props.dispatchDialogState({
                    type: "set-delete-confirm-open",
                    deleteConfirmOpen: true,
                  })
                }
              >
                Delete
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                props.dispatchDialogState({ type: "close-dialog" });
              }}
            >
              Cancel
            </Button>
            <Button form={props.addScriptFormId} type="submit">
              {props.isEditing ? "Save changes" : "Save action"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog
        open={props.deleteConfirmOpen}
        onOpenChange={(open) =>
          props.dispatchDialogState({ type: "set-delete-confirm-open", deleteConfirmOpen: open })
        }
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete action "{props.name}"?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={props.confirmDeleteScript}>
              Delete action
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
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
    runOnWorktreeCreate,
    env,
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
      const parsedEnv = parseProjectScriptEnv(env);
      const payload = {
        name: trimmedName,
        command: trimmedCommand,
        icon,
        runOnWorktreeCreate,
        env: parsedEnv,
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
      env: formatProjectScriptEnv(script.env),
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
      <div className="space-y-1" aria-label="Project actions">
        {primaryScript ? null : (
          <button
            type="button"
            className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            onClick={openAddDialog}
          >
            <PlusIcon className="size-4" />
            <span>Add action</span>
          </button>
        )}
        {scripts.map((script) => {
          const shortcutLabel = shortcutLabelForCommand(
            keybindings,
            commandForProjectScript(script.id),
          );
          return (
            <div
              key={script.id}
              className="group/script flex min-h-9 items-center gap-1 rounded-lg transition-colors hover:bg-accent/60"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-[13px] text-foreground"
                onClick={() => onRunScript(script)}
                aria-label={`Run ${script.name}`}
              >
                <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-md bg-muted/50 text-muted-foreground group-hover/script:text-foreground">
                  <ScriptIcon icon={script.icon} className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{script.name}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    {script.runOnWorktreeCreate ? (
                      <Badge variant="outline" size="sm" className="h-4 px-1 text-[9px]">
                        setup
                      </Badge>
                    ) : null}
                    {shortcutLabel ? <span className="truncate">{shortcutLabel}</span> : null}
                  </span>
                </span>
                <PlayIcon className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/script:opacity-100" />
              </button>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="mr-1 size-7 rounded-md text-muted-foreground opacity-70 hover:bg-accent hover:text-foreground group-hover/script:opacity-100"
                      aria-label={`Edit ${script.name}`}
                      onClick={() => openEditDialog(script)}
                    />
                  }
                >
                  <SettingsIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="left">Edit action</TooltipPopup>
              </Tooltip>
            </div>
          );
        })}
        {primaryScript ? (
          <button
            type="button"
            className="flex min-h-8 w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            onClick={openAddDialog}
          >
            <PlusIcon className="size-4" />
            <span>Add action</span>
          </button>
        ) : null}
      </div>

      <ProjectScriptEditorDialog
        addScriptFormId={addScriptFormId}
        captureKeybinding={captureKeybinding}
        command={command}
        confirmDeleteScript={confirmDeleteScript}
        deleteConfirmOpen={deleteConfirmOpen}
        dialogOpen={dialogOpen}
        dispatchDialogState={dispatchDialogState}
        icon={icon}
        isEditing={isEditing}
        keybinding={keybinding}
        name={name}
        runOnWorktreeCreate={runOnWorktreeCreate}
        env={env}
        submitAddScript={submitAddScript}
        validationError={validationError}
      />
    </>
  );
}
