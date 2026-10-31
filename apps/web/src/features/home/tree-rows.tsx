import {
  ArrowClockwiseIcon,
  ArrowRightIcon,
  CaretDownIcon,
  CaretRightIcon,
  ClockCounterClockwiseIcon,
  NotePencilIcon,
  PlusIcon,
  PulseIcon,
  TrayIcon,
} from "@phosphor-icons/react";
import { inboxFold, projectBadge, projectFold, type HomeFocus, type HomeRow } from "@ace/ui-core";
import { useEffect, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { useProjectName } from "@/lib/projects.ts";
import { useProjectDialogs } from "@/features/projects/index.ts";
import { useOrganizer, useOrganizerState } from "@/features/organize/index.ts";
import { ProjectMark } from "./row-parts.tsx";

/*
 * The Threads panel's rows that aren't threads: the Inbox heading, the Running and Recent
 * places, the Projects label, each project's heading and its "N settled", Quiet projects,
 * Snoozed, the labels of search and Recent, and the foot while older threads load.
 */

/** What a section row asks the panel to do. */
export interface SectionActions {
  /** Open a focused list. */
  focus(focus: HomeFocus): void;
  /** Load the next page of older settled threads (`key`: the list asking). */
  more(): void;
}

const heading =
  "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 text-left focus-ring-inset transition-colors duration-(--motion-fast)";
const mini =
  "grid size-6 shrink-0 place-items-center rounded-sm text-subtle-foreground opacity-0 transition-opacity duration-(--motion-fast) group-hover/head:opacity-100 group-focus-within/head:opacity-100 hover:bg-hover hover:text-foreground focus-ring pointer-coarse:opacity-100";
const label =
  "mt-2.5 flex h-7 w-full items-center gap-1.5 px-2.5 text-xs font-medium text-subtle-foreground";

function Caret(props: { open: boolean }) {
  return (
    <CaretDownIcon
      aria-hidden
      size={12}
      className={cn(
        "shrink-0 text-subtle-foreground transition-transform duration-(--motion-base) ease-spring",
        !props.open && "-rotate-90",
      )}
    />
  );
}

/** A small action that shows on the heading's hover or focus. */
function Mini(props: { label: string; onClick(): void; children: ReactNode }) {
  return (
    <Tip label={props.label}>
      <button
        type="button"
        aria-label={props.label}
        onClick={props.onClick}
        // Out of the Tab order, as a row's actions are: → reaches it from its heading.
        tabIndex={-1}
        className={mini}
      >
        {props.children}
      </button>
    </Tip>
  );
}

/** Inbox's count: warning-coloured, as what asks the person always is. */
function Waiting(props: { count: number; label: string }) {
  return (
    <>
      <span
        aria-hidden
        className="shrink-0 rounded-full bg-status-needs-you/15 px-1.5 text-2xs leading-4 font-medium text-status-needs-you tabular-nums"
      >
        {props.count}
      </span>
      <span className="sr-only">, {props.label}</span>
    </>
  );
}

function InboxHeader(props: { row: Extract<HomeRow, { kind: "inbox-header" }> } & Acts) {
  const organizer = useOrganizer();
  const { row } = props;
  return (
    <div className="group/head flex items-center rounded-md hover:bg-hover">
      <button
        type="button"
        aria-expanded={row.open}
        data-section-toggle=""
        onClick={() => organizer.setFolded(inboxFold, row.open)}
        className={cn(heading, "font-semibold text-foreground")}
      >
        <Caret open={row.open} />
        <TrayIcon aria-hidden size={14} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">Inbox</span>
        {row.count > 0 && <Waiting count={row.count} label={`${row.count} need you`} />}
      </button>
      <span className="pr-1">
        <Mini label="Open Inbox" onClick={() => props.actions.focus({ kind: "inbox" })}>
          <ArrowRightIcon aria-hidden size={12} />
        </Mini>
      </span>
    </div>
  );
}

function ProjectHeader(props: { row: Extract<HomeRow, { kind: "project-header" }> } & Acts) {
  const { row } = props;
  const organizer = useOrganizer();
  const name = useProjectName()(row.project);
  const navigate = useNavigate();
  return (
    <div className="group/head mt-0.5 flex items-center rounded-md hover:bg-hover">
      <button
        type="button"
        aria-expanded={row.open}
        data-section-toggle=""
        data-project={row.project}
        onClick={() => organizer.setFolded(projectFold(row.project), row.open)}
        className={cn(heading, "font-medium text-foreground")}
      >
        <Caret open={row.open} />
        <ProjectMark id={row.project} badge={projectBadge({ id: row.project, name })} />
        <span className="min-w-0 truncate">{name}</span>
        {row.running > 0 && (
          <>
            <span
              aria-hidden
              className="inline-flex shrink-0 items-center gap-1 text-2xs text-subtle-foreground tabular-nums"
            >
              <span className="size-1.5 rounded-full bg-status-working" />
              {row.running}
            </span>
            <span className="sr-only">, {row.running} running</span>
          </>
        )}
        <span className="flex-1" />
        {row.inbox > 0 && !row.open && (
          <Waiting count={row.inbox} label={`${row.inbox} in the Inbox`} />
        )}
      </button>
      <span className="flex items-center gap-0.5 pr-1">
        <Mini
          label={`New thread in ${name}`}
          onClick={() => void navigate({ to: "/new", search: { project: row.project } })}
        >
          <NotePencilIcon aria-hidden size={14} />
        </Mini>
        <Mini
          label={`Open ${name}`}
          onClick={() => props.actions.focus({ kind: "project", id: row.project, tab: "active" })}
        >
          <ArrowRightIcon aria-hidden size={12} />
        </Mini>
      </span>
    </div>
  );
}

function ProjectsLabel() {
  const projects = useProjectDialogs();
  return (
    <div className={cn(label, "group/head mt-3 pr-1")}>
      <span className="flex-1">Projects</span>
      <Tip label="Add project" shortcut="addProject">
        <button
          type="button"
          aria-label="Add project"
          // A stop the arrows reach, like the headings around it.
          data-section-toggle=""
          onClick={() => projects.open({ kind: "add", tab: "sources" })}
          onPointerEnter={projects.preload}
          className="grid size-6 shrink-0 place-items-center rounded-sm text-subtle-foreground hover:bg-hover hover:text-foreground focus-ring"
        >
          <PlusIcon aria-hidden size={14} />
        </button>
      </Tip>
    </div>
  );
}

/** A one-line row that opens a focused list: Running, Recent, or a quiet project. */
function PlaceRow(props: {
  icon: ReactNode;
  text: string;
  count: string;
  onClick(): void;
  className?: string | undefined;
}) {
  return (
    <button
      type="button"
      data-section-toggle=""
      onClick={props.onClick}
      className={cn(heading, "w-full flex-none text-foreground hover:bg-hover", props.className)}
    >
      {props.icon}
      <span className="min-w-0 flex-1 truncate">{props.text}</span>
      <span aria-hidden className="shrink-0 text-xs text-subtle-foreground tabular-nums">
        {props.count}
      </span>
      <span className="sr-only">, {props.count}</span>
    </button>
  );
}

function QuietProject(props: { row: Extract<HomeRow, { kind: "quiet-project" }> } & Acts) {
  const name = useProjectName()(props.row.project);
  return (
    <PlaceRow
      icon={
        <ProjectMark
          id={props.row.project}
          badge={projectBadge({ id: props.row.project, name })}
          quiet
        />
      }
      text={name}
      count={`${props.row.settled} settled`}
      className="text-muted-foreground"
      onClick={() =>
        props.actions.focus({ kind: "project", id: props.row.project, tab: "settled" })
      }
    />
  );
}

/** A disclosure in the list: "N settled", Quiet projects, Snoozed. */
function Disclosure(props: {
  open: boolean;
  onClick(): void;
  children: ReactNode;
  /** Its name for assistive tech, when the words on it say less. */
  label?: string | undefined;
}) {
  return (
    <button
      type="button"
      aria-expanded={props.open}
      aria-label={props.label}
      data-section-toggle=""
      onClick={props.onClick}
      className="flex h-[30px] w-full items-center gap-1.5 rounded-md px-2.5 text-left text-ui text-muted-foreground focus-ring-inset transition-colors duration-(--motion-fast) hover:bg-hover hover:text-foreground"
    >
      {props.open ? (
        <CaretDownIcon aria-hidden size={12} className="shrink-0" />
      ) : (
        <CaretRightIcon aria-hidden size={12} className="shrink-0" />
      )}
      {props.children}
    </button>
  );
}

/** The foot while older settled threads are left: on sight it asks for the next page. */
function MoreRow(props: { state: "more" | "loading" | "error" } & Acts) {
  const { state, actions } = props;
  useEffect(() => {
    if (state === "more") actions.more();
  }, [state, actions]);
  if (state !== "error")
    return (
      <div
        role="status"
        className="flex h-[30px] items-center px-2.5 text-ui text-subtle-foreground"
      >
        Loading older threads…
      </div>
    );
  return (
    <button
      type="button"
      data-section-toggle=""
      onClick={() => actions.more()}
      className="flex h-[30px] w-full items-center gap-2 rounded-md px-2.5 text-left text-ui text-muted-foreground focus-ring-inset transition-colors duration-(--motion-fast) hover:bg-hover hover:text-foreground"
    >
      <ArrowClockwiseIcon aria-hidden size={14} className="shrink-0" />
      Couldn’t load older threads. Retry
    </button>
  );
}

/** A project's "N settled", named with its project for assistive tech. */
function ProjectSettled(props: { row: Extract<HomeRow, { kind: "project-settled" }> }) {
  const { row } = props;
  const organizer = useOrganizer();
  const name = useProjectName()(row.project);
  return (
    <Disclosure
      open={row.open}
      label={`${row.count} settled in ${name}`}
      onClick={() => organizer.setSettledOpen(row.project, !row.open)}
    >
      {row.count} settled
    </Disclosure>
  );
}

interface Acts {
  actions: SectionActions;
}

/** One section row; nothing for a thread row, which the list draws itself. */
export function SectionRow(props: { row: HomeRow; first: boolean } & Acts) {
  const { row, actions } = props;
  const organizer = useOrganizer();
  const { snoozedOpen } = useOrganizerState();
  switch (row.kind) {
    case "inbox-header":
      return <InboxHeader row={row} actions={actions} />;
    case "project-header":
      return <ProjectHeader row={row} actions={actions} />;
    case "projects-label":
      return <ProjectsLabel />;
    case "place":
      return row.place === "running" ? (
        <PlaceRow
          className="mt-0.5"
          icon={<PulseIcon aria-hidden size={14} className="shrink-0 text-muted-foreground" />}
          text="Running"
          count={String(row.count)}
          onClick={() => actions.focus({ kind: "running" })}
        />
      ) : (
        <PlaceRow
          icon={
            <ClockCounterClockwiseIcon
              aria-hidden
              size={14}
              className="shrink-0 text-muted-foreground"
            />
          }
          text="Recent"
          count={String(row.count)}
          onClick={() => actions.focus({ kind: "recent" })}
        />
      );
    case "project-settled":
      return <ProjectSettled row={row} />;
    case "quiet-header":
      return (
        <div className="mt-1.5">
          <Disclosure open={row.open} onClick={() => organizer.setQuietOpen(!row.open)}>
            Quiet projects · <span className="tabular-nums">{row.count}</span>
          </Disclosure>
        </div>
      );
    case "quiet-project":
      return <QuietProject row={row} actions={actions} />;
    case "snoozed-header":
      return (
        <div className="mt-2.5">
          <Disclosure open={snoozedOpen} onClick={() => organizer.setSnoozedOpen(!snoozedOpen)}>
            Snoozed <span className="tabular-nums">{row.count}</span>
          </Disclosure>
        </div>
      );
    case "label":
      return (
        <div role="heading" aria-level={3} className={cn(label, props.first && "mt-0")}>
          {row.label}
          {row.count !== undefined && (
            <>
              {" · "}
              <span className="font-normal tabular-nums">{row.count}</span>
            </>
          )}
        </div>
      );
    case "empty":
      return <p className="px-2.5 py-2 text-ui text-subtle-foreground">{row.text}</p>;
    case "settled-more":
      return <MoreRow state={row.state} actions={actions} />;
    default:
      return null;
  }
}
