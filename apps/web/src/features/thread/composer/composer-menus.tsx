import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import {
  ArrowCounterClockwiseIcon,
  AtIcon,
  CheckIcon,
  CommandIcon,
  ImageIcon,
  InfoIcon,
  PaperclipIcon,
} from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { MenuGroup, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/menu.tsx";
import { menuItem } from "@/components/ui/menu-styles.ts";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import type { ThreadRef } from "../sources/index.ts";
import { riskIcons } from "./permission-icons.ts";
import type { PermissionMenuView } from "./permission-view.ts";
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
 * The approval modes the provider offers, each with what it means in one line, then once what
 * the provider gates in the mode in effect. A mode it can't honour shows disabled, with why. A
 * thread with its own mode can go back to the default, unless the provider can't run in it.
 * It reads a generic `{id, label, description, risk}` list, so a provider's native modes need
 * nothing of their own.
 */
export function PermissionMenu(props: {
  view: PermissionMenuView;
  onChange(id: string | null): void;
}) {
  const { view } = props;
  if (view.unavailable) return <Note>{view.unavailable}</Note>;
  if (view.loading) return <Note pending>Checking what the provider can gate…</Note>;
  if (!view.options.length)
    return <Note>This provider doesn't report approval modes, so they can't be changed here.</Note>;
  return (
    <>
      {view.fallback && <Note>{view.fallback}</Note>}
      <MenuGroup>
        <MenuLabel>Approvals</MenuLabel>
        <MenuPrimitive.RadioGroup
          value={view.value ?? ""}
          onValueChange={(value: string) => {
            const option = view.options.find((entry) => entry.id === value);
            if (option && !option.unavailable) props.onChange(option.id);
          }}
        >
          {view.options.map((option) => {
            const attention = option.risk === "high";
            return (
              <MenuPrimitive.RadioItem
                key={option.id}
                value={option.id}
                aria-label={option.label}
                disabled={!!option.unavailable}
                closeOnClick
                className={cn(menuItem, "h-auto items-start py-2")}
              >
                <Icon
                  icon={riskIcons[option.risk]}
                  className={cn("mt-px", attention && "text-status-needs-you!")}
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 whitespace-normal">
                  <span className={cn(attention && "text-status-needs-you")}>{option.label}</span>
                  <span className="truncate text-xs leading-4 text-muted-foreground">
                    {option.unavailable ?? option.description}
                  </span>
                </span>
                <span className="grid size-4 shrink-0 place-items-center">
                  <MenuPrimitive.RadioItemIndicator>
                    <CheckIcon aria-hidden size={14} />
                  </MenuPrimitive.RadioItemIndicator>
                </span>
              </MenuPrimitive.RadioItem>
            );
          })}
        </MenuPrimitive.RadioGroup>
      </MenuGroup>
      {view.coverage && (
        <p className="flex items-start gap-2 px-2.5 pt-1.5 pb-1 text-xs leading-4 text-subtle-foreground">
          <InfoIcon aria-hidden size={14} className="mt-px shrink-0" />
          {view.coverage}
        </p>
      )}
      {view.reset && (
        <>
          <MenuSeparator />
          <MenuItem
            icon={<Icon icon={ArrowCounterClockwiseIcon} />}
            reason={view.reset.unavailable}
            disabled={!!view.reset.unavailable}
            onClick={() => props.onChange(null)}
          >
            Use the default · {view.reset.label}
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
