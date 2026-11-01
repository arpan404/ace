import {
  CaretDownIcon,
  CaretRightIcon,
  ClockCounterClockwiseIcon,
  FolderOpenIcon,
  FolderSimpleIcon,
  NotePencilIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { chatDayLabels, projectFold, projectMore, type HomeRow } from "@ace/ui-core";
import type { ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Icon } from "@/components/icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { useProjectName } from "@/lib/projects.ts";
import { useProjectDialogs } from "@/features/projects/index.ts";
import { useOrganizer, useOrganizerState } from "@/features/organize/index.ts";

/*
 * The Threads panel's rows that aren't threads: the Pinned and Projects labels, each project's
 * row, Show more, Quiet projects and Snoozed; and the Chats panel's day labels. Every row is one `--row-height` line; a section
 * label leaves 20px above it.
 */

const line =
  "flex h-(--row-height) min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-md focus-ring-inset transition-colors duration-(--motion-fast)";
const mini =
  "grid size-6 shrink-0 place-items-center rounded-sm text-subtle-foreground hover:bg-hover hover:text-foreground focus-ring";
const label = "flex h-7 w-full items-center gap-1.5 px-2.5 text-ui text-muted-foreground";

/** A small action that shows on the row's hover or focus. */
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

/**
 * A project's one mark, as a thread row's: the warning dot while threads of it wait in the
 * Inbox, else, folded, the live ring while any of its threads run. Silent: the row says it.
 */
function ProjectMark(props: { row: Extract<HomeRow, { kind: "project-header" }> }) {
  const { row } = props;
  if (row.inbox > 0)
    return (
      <span
        aria-hidden
        data-tone="needs-you"
        className="size-2 shrink-0 rounded-full bg-(--tone)"
      />
    );
  if (row.running > 0 && !row.open)
    return (
      <span
        aria-hidden
        data-tone="working"
        className="size-2 shrink-0 rounded-full shadow-[inset_0_0_0_1.5px_var(--tone)]"
      />
    );
  return null;
}

function ProjectRow(props: { row: Extract<HomeRow, { kind: "project-header" }> }) {
  const { row } = props;
  const organizer = useOrganizer();
  const name = useProjectName()(row.project);
  const navigate = useNavigate();
  return (
    <div className="group/head flex items-center rounded-md hover:bg-hover">
      <button
        type="button"
        aria-expanded={row.open}
        data-section-toggle=""
        data-project={row.project}
        onClick={() => organizer.setFolded(projectFold(row.project), row.open)}
        className={cn(line, "flex-1 text-foreground")}
      >
        <Icon
          icon={row.open ? FolderOpenIcon : FolderSimpleIcon}
          className="text-muted-foreground"
        />
        <span className="min-w-0 truncate">{name}</span>
        {row.running > 0 && <span className="sr-only">, {row.running} running</span>}
        {row.inbox > 0 && <span className="sr-only">, {row.inbox} in the Inbox</span>}
        <span className="flex-1" />
        <span className="flex group-focus-within/head:hidden group-hover/head:hidden pointer-coarse:hidden">
          <ProjectMark row={row} />
        </span>
      </button>
      <span className="hidden items-center gap-0.5 pr-1.5 group-focus-within/head:flex group-hover/head:flex pointer-coarse:flex">
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
    <div className={cn(label, "group/head pr-1.5", props.first ? "mt-1" : "mt-5")}>
      <span className="flex-1">Projects</span>
      <Tip label="Add project" shortcut="addProject">
        <button
          type="button"
          aria-label="Add project"
          // A stop the arrows reach, like the headings around it.
          data-section-toggle=""
          onClick={() => projects.open({ kind: "add", tab: "sources" })}
          onPointerEnter={projects.preload}
          className={cn(
            mini,
            "opacity-0 transition-opacity duration-(--motion-fast) group-hover/head:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
          )}
        >
          <PlusIcon aria-hidden size={14} />
        </button>
      </Tip>
    </div>
  );
}

/** Past a project's first five rows: the rest, one press away. */
function ShowMore(props: { row: Extract<HomeRow, { kind: "show-more" }> }) {
  const organizer = useOrganizer();
  const name = useProjectName()(props.row.project);
  return (
    <button
      type="button"
      aria-expanded={props.row.open}
      aria-label={
        props.row.open ? `Show fewer in ${name}` : `Show ${props.row.hidden} more in ${name}`
      }
      data-section-toggle=""
      onClick={() => organizer.setFolded(projectMore(props.row.project), !props.row.open)}
      className={cn(line, "w-full text-subtle-foreground hover:bg-hover hover:text-foreground")}
    >
      <span aria-hidden className="w-4 shrink-0" />
      {props.row.open ? "Show less" : "Show more"}
    </button>
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
      className={cn(line, "w-full text-muted-foreground hover:bg-hover hover:text-foreground")}
    >
      <Icon icon={FolderSimpleIcon} className="text-subtle-foreground" />
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
      className={cn(
        line,
        "w-full text-ui text-muted-foreground hover:bg-hover hover:text-foreground",
      )}
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
    case "pinned-label":
      return (
        <div role="heading" aria-level={3} className={cn(label, props.first ? "mt-1" : "mt-5")}>
          Pinned
        </div>
      );
    case "project-header":
      return <ProjectRow row={row} />;
    case "projects-label":
      return <ProjectsLabel first={props.first} />;
    case "show-more":
      return <ShowMore row={row} />;
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
    case "empty":
      return <p className="py-2 pr-2.5 pl-9 text-ui text-subtle-foreground">{row.text}</p>;
    case "day-label":
      return (
        <div role="heading" aria-level={3} className={cn(label, props.first ? "mt-1" : "mt-5")}>
          {chatDayLabels[row.day]}
        </div>
      );
    default:
      return null;
  }
}
