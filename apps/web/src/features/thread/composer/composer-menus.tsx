import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { PermissionCapabilities, PermissionMode, ProviderKind } from "@ace/protocol";
import {
  accountTag,
  permissionChoices,
  permissionCoverageNote,
  permissionLabel,
  providerNames,
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
  InfoIcon,
  PaperclipIcon,
} from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { MenuGroup, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/menu.tsx";
import { menuItem } from "@/components/ui/menu-styles.ts";
import { Spinner } from "@/components/ui/spinner.tsx";
import { EffortSection, ProviderLabel } from "@/features/models/index.ts";
import { cn } from "@/lib/cn.ts";
import type { ThreadRef } from "../sources/index.ts";
import { DescribedItem } from "./described-item.tsx";
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
 * what this provider actually gates. A thread with its own mode can go back to the default.
 */
export function PermissionMenu(props: {
  mode: PermissionMode | undefined;
  capabilities: PermissionCapabilities | undefined;
  provider?: ProviderKind | undefined;
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
                <span className="truncate text-xs leading-4 text-muted-foreground">
                  {choice.description}
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
        {permissionCoverageNote(
          props.capabilities,
          props.provider ? providerNames[props.provider] : "This provider",
          props.mode,
        )}
      </p>
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
 * The + menu: upload files or images, mention a file, start a command, and (in a thread) plan
 * first or point the agent at a page open in the workspace; then files mentioned lately in this
 * project. Each row says what it does, or why it can't now. Drop and paste still attach files.
 */
export function AddMenu(props: {
  files: AddAction;
  images: AddAction;
  mention: AddAction;
  command: AddAction;
  recent: readonly string[];
  /** The thread the composer writes in, for its own rows; none on New thread. */
  thread?: ThreadRef | undefined;
  onFiles(): void;
  onImages(): void;
  onMention(): void;
  onCommand(): void;
  onRecent(path: string): void;
  onInsert(text: string): void;
}) {
  return (
    <>
      <MenuGroup>
        <MenuLabel>Add to the message</MenuLabel>
        <DescribedItem
          icon={<Icon icon={PaperclipIcon} />}
          description="Attach from this computer"
          reason={props.files.reason}
          onClick={props.onFiles}
        >
          Files
        </DescribedItem>
        <DescribedItem
          icon={<Icon icon={ImageIcon} />}
          description="PNG, JPG, screenshots"
          reason={props.images.reason}
          onClick={props.onImages}
        >
          Images
        </DescribedItem>
        <DescribedItem
          icon={<Icon icon={AtIcon} />}
          keys="@"
          description="Reference a checkout file"
          reason={props.mention.reason}
          onClick={props.onMention}
        >
          Mention a file
        </DescribedItem>
        <DescribedItem
          icon={<Icon icon={CommandIcon} />}
          keys="/"
          description="Run a slash command"
          reason={props.command.reason}
          onClick={props.onCommand}
        >
          Command
        </DescribedItem>
      </MenuGroup>
      {props.thread && (
        <>
          <MenuSeparator />
          <ThreadContextRows thread={props.thread} onInsert={props.onInsert} />
        </>
      )}
      <MenuSeparator />
      <MenuGroup>
        <MenuLabel>Recent files</MenuLabel>
        {props.recent.length ? (
          props.recent.map((path) => (
            <DescribedItem
              key={path}
              icon={<Icon icon={FileTextIcon} />}
              aria-label={`Mention ${path}`}
              description={
                path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "Project root"
              }
              reason={props.mention.reason}
              onClick={() => props.onRecent(path)}
            >
              {path.slice(path.lastIndexOf("/") + 1)}
            </DescribedItem>
          ))
        ) : (
          <DescribedItem
            icon={<Icon icon={FileTextIcon} />}
            reason="Files you mention in this project show here"
          >
            No recent files
          </DescribedItem>
        )}
      </MenuGroup>
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
        reported={props.effort.reported}
        provider={props.value?.provider}
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
                  <ChoiceItem
                    key={choice.id}
                    choice={choice}
                    selected={choice.id === props.value?.id}
                  />
                ))}
            </MenuPrimitive.Group>
          </Fragment>
        ))}
      </MenuPrimitive.RadioGroup>
    </>
  );
}

/**
 * One model on one account. A single line (the model, its account and how much of the window
 * it has used) keeps the list short; the chosen one adds its note and usage meter beneath, and
 * one at its limit says when it resets.
 */
function ChoiceItem(props: { choice: ModelChoice; selected: boolean }) {
  const { choice } = props;
  const exhausted = choice.exhausted;
  const account = accountTag(choice.account);
  const detail = exhausted
    ? limitReached(choice.resetsAt)
    : props.selected
      ? choice.note
      : undefined;
  return (
    <MenuPrimitive.RadioItem
      value={choice.id}
      disabled={exhausted}
      aria-label={`${choice.model} · ${account}`}
      className={cn(menuItem, "h-auto min-h-[30px] items-start py-1.5")}
    >
      <span className="mt-px grid w-4 shrink-0 place-items-center">
        <MenuPrimitive.RadioItemIndicator>
          <CheckIcon aria-hidden size={14} />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate">{choice.model}</span>
          <span className="min-w-0 shrink-[2] truncate text-xs text-subtle-foreground">
            {account}
          </span>
          {!props.selected && !exhausted && choice.used !== undefined && (
            <span className="ml-auto shrink-0 text-xs text-subtle-foreground tabular-nums">
              {Math.round(choice.used * 100)}%
            </span>
          )}
        </span>
        {detail && <span className="mt-px text-xs text-subtle-foreground">{detail}</span>}
        {props.selected && choice.used !== undefined && (
          <span
            role="meter"
            aria-label={`${account} usage`}
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
