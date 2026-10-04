import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { PermissionCapabilities, PermissionMode } from "@ace/protocol";
import {
  accountTag,
  permissionChoices,
  permissionLabel,
  type EffortControl,
  type ModelChoice,
} from "@ace/ui-core";
import { Fragment } from "react";
import {
  ArrowCounterClockwiseIcon,
  AtIcon,
  CheckIcon,
  CommandIcon,
  FileTextIcon,
  ImageIcon,
  PaperclipIcon,
} from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { MenuGroup, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/menu.tsx";
import { menuItem } from "@/components/ui/menu-styles.ts";
import { Spinner } from "@/components/ui/spinner.tsx";
import { EffortSection, ProviderLabel } from "@/features/models/index.ts";
import { cn } from "@/lib/cn.ts";
import { permissionIcons } from "./permission-icons.ts";

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
 * The approval modes the provider supports, each with what it means and what this provider can
 * actually gate in it. A thread with its own mode can go back to the default.
 */
export function PermissionMenu(props: {
  mode: PermissionMode | undefined;
  capabilities: PermissionCapabilities | undefined;
  loading: boolean;
  unavailable?: string | undefined;
  inherited?: boolean | undefined;
  defaultMode?: PermissionMode | undefined;
  onChange(mode: PermissionMode | null): void;
}) {
  if (props.unavailable) return <Note>{props.unavailable}</Note>;
  if (props.loading) return <Note pending>Checking what the provider can gate…</Note>;
  const choices = permissionChoices(props.capabilities);
  if (!choices.length)
    return <Note>This provider doesn't report approval modes, so they can't be changed here.</Note>;
  return (
    <>
      <MenuGroup>
        <MenuLabel>How actions get approved</MenuLabel>
        <MenuPrimitive.RadioGroup
          value={props.mode ?? ""}
          onValueChange={(value: string) => {
            const choice = choices.find((entry) => entry.mode === value);
            if (choice) props.onChange(choice.mode);
          }}
        >
          {choices.map((choice) => (
            <MenuPrimitive.RadioItem
              key={choice.mode}
              value={choice.mode}
              aria-label={choice.label}
              closeOnClick
              className={cn(menuItem, "h-auto items-start py-2")}
            >
              <Icon
                icon={permissionIcons[choice.mode]}
                className={cn("mt-px", choice.attention && "text-status-needs-you!")}
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 whitespace-normal">
                <span className={cn(choice.attention && "text-status-needs-you")}>
                  {choice.label}
                </span>
                <span className="text-xs leading-4 text-muted-foreground">
                  {choice.description}
                </span>
                <span className="text-xs leading-4 text-subtle-foreground">{choice.coverage}</span>
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
      {props.defaultMode && !props.inherited && (
        <>
          <MenuSeparator />
          <MenuItem
            icon={<Icon icon={ArrowCounterClockwiseIcon} />}
            onClick={() => props.onChange(null)}
          >
            Use the default · {permissionLabel(props.defaultMode)}
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
 * The + menu: upload files or images, mention a file, start a command, or mention a file used
 * lately in this project. Drop and paste still attach files directly.
 */
export function AddMenu(props: {
  files: AddAction;
  images: AddAction;
  mention: AddAction;
  command: AddAction;
  recent: readonly string[];
  onFiles(): void;
  onImages(): void;
  onMention(): void;
  onCommand(): void;
  onRecent(path: string): void;
}) {
  return (
    <>
      <MenuGroup>
        <MenuLabel>Add to the message</MenuLabel>
        <MenuItem
          icon={<Icon icon={PaperclipIcon} />}
          disabled={!!props.files.reason}
          reason={props.files.reason}
          onClick={props.onFiles}
        >
          Files
        </MenuItem>
        <MenuItem
          icon={<Icon icon={ImageIcon} />}
          disabled={!!props.images.reason}
          reason={props.images.reason}
          onClick={props.onImages}
        >
          Images
        </MenuItem>
        <MenuItem
          icon={<Icon icon={AtIcon} />}
          keys="@"
          disabled={!!props.mention.reason}
          reason={props.mention.reason}
          onClick={props.onMention}
        >
          Mention a file
        </MenuItem>
        <MenuItem
          icon={<Icon icon={CommandIcon} />}
          keys="/"
          disabled={!!props.command.reason}
          reason={props.command.reason}
          onClick={props.onCommand}
        >
          Command
        </MenuItem>
      </MenuGroup>
      {props.recent.length > 0 && (
        <>
          <MenuSeparator />
          <MenuGroup>
            <MenuLabel>Recent files</MenuLabel>
            {props.recent.map((path) => (
              <MenuItem
                key={path}
                icon={<Icon icon={FileTextIcon} />}
                aria-label={`Mention ${path}`}
                disabled={!!props.mention.reason}
                onClick={() => props.onRecent(path)}
              >
                {path.slice(path.lastIndexOf("/") + 1)}
                <span className="ml-2 font-mono text-xs text-subtle-foreground">
                  {path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""}
                </span>
              </MenuItem>
            ))}
          </MenuGroup>
        </>
      )}
    </>
  );
}

const clock = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const limitReached = (resetsAt: number | undefined) =>
  resetsAt === undefined ? "Limit reached" : `Limit reached · resets ${clock.format(resetsAt)}`;

/** Effort for the thread's model, then the models by provider, each on its account with its usage. */
export function ThreadModelMenu(props: {
  choices: readonly ModelChoice[];
  value: ModelChoice | undefined;
  effort: EffortControl;
  onChange(choice: ModelChoice): void;
  onEffort(effort: string): void;
}) {
  if (!props.choices.length)
    return <Note>No signed-in account offers a model. Sign in from More › Accounts.</Note>;
  const providers = [...new Set(props.choices.map((choice) => choice.provider))];
  return (
    <>
      {/* Effort first: it is what changes most often, and a long model list would hide it. */}
      <EffortSection
        efforts={props.effort.efforts}
        value={props.effort.current}
        reason={props.effort.reason}
        place="first"
        onChange={props.onEffort}
      />
      <MenuPrimitive.RadioGroup
        value={props.value?.id ?? ""}
        onValueChange={(id: string) => {
          const choice = props.choices.find((candidate) => candidate.id === id);
          if (choice) props.onChange(choice);
        }}
      >
        {providers.map((provider, index) => (
          <Fragment key={provider}>
            {index > 0 && <MenuSeparator />}
            <MenuPrimitive.Group>
              <ProviderLabel provider={provider} />
              {props.choices
                .filter((choice) => choice.provider === provider)
                .map((choice) => (
                  <ChoiceItem key={choice.id} choice={choice} />
                ))}
            </MenuPrimitive.Group>
          </Fragment>
        ))}
      </MenuPrimitive.RadioGroup>
    </>
  );
}

function ChoiceItem(props: { choice: ModelChoice }) {
  const { choice } = props;
  const exhausted = choice.exhausted;
  return (
    <MenuPrimitive.RadioItem
      value={choice.id}
      disabled={exhausted}
      aria-label={`${choice.model} · ${accountTag(choice.account)}`}
      className={cn(menuItem, "h-auto items-start py-[7px]")}
    >
      <span className="mt-px grid w-4 shrink-0 place-items-center">
        <MenuPrimitive.RadioItemIndicator>
          <CheckIcon aria-hidden size={14} />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate">
          {choice.model} · {accountTag(choice.account)}
        </span>
        <span className="mt-px text-xs text-subtle-foreground">
          {exhausted ? limitReached(choice.resetsAt) : choice.note}
        </span>
        {choice.used !== undefined && (
          <span
            role="meter"
            aria-label={`${accountTag(choice.account)} usage`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(choice.used * 100)}
            className="mt-1.5 h-[3px] w-[150px] overflow-hidden rounded-[2px] bg-secondary"
          >
            <span
              className={cn(
                "block h-full rounded-[2px]",
                exhausted ? "bg-status-failed" : "bg-muted-foreground",
              )}
              style={{ width: `${Math.min(100, choice.used * 100)}%` }}
            />
          </span>
        )}
      </span>
    </MenuPrimitive.RadioItem>
  );
}
