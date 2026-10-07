import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { PermissionCapabilities, PermissionMode, ProviderKind } from "@ace/protocol";
import {
  permissionChoices,
  permissionCoverageNote,
  permissionLabel,
  permissionUnavailable,
  providerNames,
} from "@ace/ui-core";
import {
  ArrowCounterClockwiseIcon,
  AtIcon,
  CheckIcon,
  CommandIcon,
  ImageIcon,
  InfoIcon,
  ShieldCheckIcon,
  PaperclipIcon,
} from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { MenuGroup, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/menu.tsx";
import { menuItem } from "@/components/ui/menu-styles.ts";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import type { ThreadRef } from "../sources/index.ts";
import { permissionIcons } from "./permission-icons.ts";
import { ThreadContextRows } from "./thread-context-rows.tsx";

function Note(props: { children: string; pending?: boolean }) {
  return (
    <p
      role="status"
      className="flex min-h-8 items-center gap-2 px-2.5 py-2 text-xs leading-4 text-muted-foreground"
    >
      {props.pending && <Spinner />}
      {props.children}
    </p>
  );
}

/**
 * The approval modes the provider supports, each with what it means in one line, then once
 * what this provider actually gates. Ask shows disabled, with why, for a provider that can't
 * honour it. A thread with its own mode can go back to the default, unless the provider can't
 * run in it. `fallback` says why the mode shown isn't the one asked for.
 */
export function PermissionMenu(props: {
  mode: PermissionMode | null | undefined;
  capabilities: PermissionCapabilities | undefined;
  provider?: ProviderKind | undefined;
  loading: boolean;
  unavailable?: string | undefined;
  inherited?: boolean | undefined;
  defaultMode?: PermissionMode | null | undefined;
  fallback?: string | undefined;
  onChange(mode: PermissionMode | null): void;
}) {
  if (props.unavailable) return <Note>{props.unavailable}</Note>;
  if (props.loading) return <Note pending>Loading provider modes…</Note>;
  const provider = props.provider ? providerNames[props.provider] : "This provider";
  const choices = permissionChoices(props.capabilities, provider);
  if (!choices.length)
    return <Note>This provider doesn't report approval modes, so they can't be changed here.</Note>;
  const defaultUnavailable =
    props.defaultMode && permissionUnavailable(props.capabilities, props.defaultMode, provider);
  return (
    <>
      {props.fallback && <Note>{props.fallback}</Note>}
      <MenuGroup>
        <MenuLabel>How actions get approved</MenuLabel>
        <MenuPrimitive.RadioGroup
          value={props.mode ?? ""}
          onValueChange={(value: string) => {
            const choice = choices.find((entry) => entry.mode === value);
            if (choice && !choice.unavailable) props.onChange(choice.mode);
          }}
        >
          {choices.map((choice) => (
            <MenuPrimitive.RadioItem
              key={choice.mode}
              value={choice.mode}
              aria-label={choice.label}
              disabled={!!choice.unavailable}
              closeOnClick
              className={cn(menuItem, "h-auto items-start py-2")}
            >
              <Icon
                icon={permissionIcons[choice.mode] ?? ShieldCheckIcon}
                className={cn("mt-px", choice.attention && "text-status-needs-you!")}
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 whitespace-normal">
                <span className={cn(choice.attention && "text-status-needs-you")}>
                  {choice.label}
                </span>
                <span className="truncate text-xs leading-4 text-muted-foreground">
                  {choice.unavailable ?? choice.description}
                </span>
              </span>
              <span className="grid size-4 shrink-0 place-items-center">
                <MenuPrimitive.RadioItemIndicator>
                  <CheckIcon aria-hidden size={14} />
                </MenuPrimitive.RadioItemIndicator>
              </span>
            </MenuPrimitive.RadioItem>
          ))}
        </MenuPrimitive.RadioGroup>
      </MenuGroup>
      <p className="flex items-start gap-2 px-2.5 pt-1.5 pb-1 text-xs leading-4 text-subtle-foreground">
        <InfoIcon aria-hidden size={14} className="mt-px shrink-0" />
        {permissionCoverageNote(props.capabilities, provider, props.mode)}
      </p>
      {!props.inherited && (
        <>
          <MenuSeparator />
          <MenuItem
            icon={<Icon icon={ArrowCounterClockwiseIcon} />}
            reason={defaultUnavailable || undefined}
            disabled={!!defaultUnavailable}
            onClick={() => props.onChange(null)}
          >
            Use the default · {permissionLabel(props.defaultMode, props.capabilities)}
          </MenuItem>
        </>
      )}
    </>
  );
}

/** One way of adding to the message, or why it isn't available now. */
export interface AddAction {
  reason?: string | undefined;
}

/**
 * The + menu, one line a row: attach files or images, mention a file (recent ones come first in
 * the list it opens), start a command, then (in a thread) plan first or point the agent at a page
 * open in the workspace. A row that can't be used says why beneath it. Drop and paste still
 * attach files.
 */
export function AddMenu(props: {
  files: AddAction;
  images: AddAction;
  mention: AddAction;
  command: AddAction;
  /** The thread the composer writes in, for its own rows; none on New thread. */
  thread?: ThreadRef | undefined;
  onFiles(): void;
  onImages(): void;
  onMention(): void;
  onCommand(): void;
  onInsert(text: string): void;
}) {
  const row = (action: AddAction) => ({ reason: action.reason, disabled: !!action.reason });
  return (
    <>
      <MenuGroup aria-label="Attach">
        <MenuItem
          icon={<Icon icon={PaperclipIcon} />}
          {...row(props.files)}
          onClick={props.onFiles}
        >
          Files
        </MenuItem>
        <MenuItem icon={<Icon icon={ImageIcon} />} {...row(props.images)} onClick={props.onImages}>
          Images
        </MenuItem>
      </MenuGroup>
      <MenuSeparator />
      <MenuGroup aria-label="Insert">
        <MenuItem
          icon={<Icon icon={AtIcon} />}
          keys="@"
          {...row(props.mention)}
          onClick={props.onMention}
        >
          Mention a file
        </MenuItem>
        <MenuItem
          icon={<Icon icon={CommandIcon} />}
          keys="/"
          {...row(props.command)}
          onClick={props.onCommand}
        >
          Command
        </MenuItem>
      </MenuGroup>
      {props.thread && (
        <>
          <MenuSeparator />
          <ThreadContextRows thread={props.thread} onInsert={props.onInsert} />
        </>
      )}
    </>
  );
}
