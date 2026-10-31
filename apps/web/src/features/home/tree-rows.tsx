import {
  CaretDownIcon,
  CaretRightIcon,
  ClockCounterClockwiseIcon,
  NotePencilIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { projectBadge, projectFold, type HomeRow } from "@ace/ui-core";
import type { ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { useProjectName } from "@/lib/projects.ts";
import { useProjectDialogs } from "@/features/projects/index.ts";
import { useOrganizer, useOrganizerState } from "@/features/organize/index.ts";
import { ProjectMark } from "./row-parts.tsx";

/*
 * The Threads panel's rows that aren't threads: the Projects label, each project's heading,
 * Quiet projects, Snoozed, and the labels of search.
 */

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

/** A project's Inbox count: warning-coloured, as what asks the person always is. */
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

function ProjectHeader(props: { row: Extract<HomeRow, { kind: "project-header" }> }) {
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
        {row.inbox > 0 && <Waiting count={row.inbox} label={`${row.inbox} in the Inbox`} />}
      </button>
      <span className="flex items-center gap-0.5 pr-1">
        <Mini
          label={`New thread in ${name}`}
          onClick={() => void navigate({ to: "/new", search: { project: row.project } })}
        >
          <NotePencilIcon aria-hidden size={14} />
        </Mini>
        <Mini
          label={`History of ${name}`}
          onClick={() => void navigate({ to: "/history", search: { project: row.project } })}
        >
          <ClockCounterClockwiseIcon aria-hidden size={14} />
        </Mini>
      </span>
    </div>
  );
}

function ProjectsLabel(props: { first: boolean }) {
  const projects = useProjectDialogs();
  return (
    <div className={cn(label, "group/head pr-1", props.first ? "mt-1" : "mt-3")}>
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

/** A quiet project: one line that opens its History. */
function QuietProject(props: { row: Extract<HomeRow, { kind: "quiet-project" }> }) {
  const name = useProjectName()(props.row.project);
  return (
    <Link
      to="/history"
      search={{ project: props.row.project }}
      data-section-toggle=""
      aria-label={`${name}, History`}
      className={cn(heading, "w-full flex-none text-muted-foreground hover:bg-hover")}
    >
      <ProjectMark
        id={props.row.project}
        badge={projectBadge({ id: props.row.project, name })}
        quiet
      />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span aria-hidden className="shrink-0 text-xs text-subtle-foreground">
        History
      </span>
    </Link>
  );
}

/** A disclosure in the list: Quiet projects, Snoozed. */
function Disclosure(props: { open: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-expanded={props.open}
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

/** One section row; nothing for a thread row, which the list draws itself. */
export function SectionRow(props: { row: HomeRow; first: boolean }) {
  const { row } = props;
  const organizer = useOrganizer();
  const { snoozedOpen } = useOrganizerState();
  switch (row.kind) {
    case "project-header":
      return <ProjectHeader row={row} />;
    case "projects-label":
      return <ProjectsLabel first={props.first} />;
    case "quiet-header":
      return (
        <div className="mt-1.5">
          <Disclosure open={row.open} onClick={() => organizer.setQuietOpen(!row.open)}>
            Quiet projects · <span className="tabular-nums">{row.count}</span>
          </Disclosure>
        </div>
      );
    case "quiet-project":
      return <QuietProject row={row} />;
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
    default:
      return null;
  }
}
