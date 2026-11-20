import {
  spadeAgentNameMax,
  spadeConnectorLine,
  spadeTaskFirstLine,
  type SpadeBubble,
  type SpadeCatalogueEntry,
} from "@ace/ui-core/spade-chat";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { AppMark } from "@/components/ui/app-mark.tsx";
import { cn } from "@/lib/cn.ts";
import { AddConnectorDialog } from "./spade-add-connector.tsx";
import { useSpadeConnectors } from "./spade-connector-api.ts";
import { SpadeFace } from "./spade-face.tsx";
import { FaceButton } from "./spade-profile-head.tsx";
import { useEditBot } from "./spade-profile-actions.ts";
import type { RosterBot } from "./use-spade-roster.ts";

/*
 * A bot changing itself, as its chat shows it (spade/docs/agents.md, "A bot's task over time"):
 * one quiet line where it happened, in words, with text buttons. Never a bubble, never a tint.
 */

type TaskChanged = Extract<SpadeBubble, { kind: "task-changed" }>;
type Named = Extract<SpadeBubble, { kind: "named" }>;

const line = "ml-1.5 flex min-h-7 max-w-full min-w-0 flex-wrap items-center gap-x-2 text-ui";
const word = "h-7 px-1.5 text-ui";

/**
 * "Updated its task: Also covers Slack", with See change (what it was and what it is now) and
 * Undo, which puts the task before it back. Undone, the line says so; once the task moved on
 * past this change, Undo goes.
 */
export function TaskChangedLine(props: { item: TaskChanged; bot: RosterBot }) {
  const { item, bot } = props;
  const edit = useEditBot(bot);
  const [open, setOpen] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [problem, setProblem] = useState<string>();
  const summary = item.why || spadeTaskFirstLine(item.task, 80);
  const current = bot.task.trim();
  const undone = current === item.previous.trim() && current !== item.task.trim();
  const undo = async () => {
    setUndoing(true);
    const refused = await edit({ task: item.previous, task_why: "Undid its change" });
    setUndoing(false);
    setProblem(refused);
  };
  return (
    <div className="flex flex-col gap-1">
      <div role="note" aria-label={`Updated its task: ${summary}`} className={line}>
        <span className="min-w-0 text-muted-foreground">
          Updated its task: <span className="text-foreground">{summary}</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          className={word}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "Hide change" : "See change"}
        </Button>
        {undone ? (
          <span className="text-muted-foreground">Undone</span>
        ) : (
          current === item.task.trim() && (
            <Button
              variant="ghost"
              size="sm"
              className={word}
              disabled={undoing}
              onClick={() => void undo()}
            >
              {undoing ? "Undoing…" : "Undo"}
            </Button>
          )
        )}
      </div>
      {open && <TaskDiff before={item.previous} after={item.task} />}
      {problem && (
        <p role="alert" className="ml-3 text-xs text-destructive">
          {`Couldn't undo it. ${problem}`}
        </p>
      )}
    </div>
  );
}

/** A task before and after, small: what it said struck through, then what it says now. */
export function TaskDiff(props: { before: string | undefined; after: string }) {
  return (
    <dl
      aria-label="Task change"
      className="ml-3 flex max-w-[64ch] flex-col gap-1 rounded-xl bg-chat-well px-3 py-2 text-ui leading-5 whitespace-pre-wrap wrap-anywhere"
    >
      {props.before !== undefined && (
        <>
          <dt className="text-xs text-muted-foreground">Before</dt>
          <dd className="text-muted-foreground line-through decoration-border">
            {props.before || "No task"}
          </dd>
        </>
      )}
      <dt className="text-xs text-muted-foreground">Now</dt>
      <dd className="text-foreground">{props.after}</dd>
    </dl>
  );
}

/**
 * The bot named itself: its face, which opens the face popover, and its name, which turns into
 * its field, each changed with one click where they show. A later rename the person agreed to is
 * a note only. Under its first name, the apps its task names that aren't connected yet.
 */
export function NamedLine(props: { item: Named; bot: RosterBot }) {
  const { item, bot } = props;
  if (!item.first)
    return (
      <p role="note" className={cn(line, "text-muted-foreground")}>
        <span>
          Changed its name to <span className="text-foreground">{item.name}</span>
        </span>
      </p>
    );
  return (
    <div className="flex flex-col gap-1">
      <div role="note" aria-label={`Named itself ${bot.name}`} className={line}>
        <FaceButton bot={bot} label={`Change ${bot.name}'s face`}>
          <SpadeFace avatar={bot.avatar} size={20} state="idle" />
        </FaceButton>
        <span className="text-muted-foreground">Named itself</span>
        <InlineName bot={bot} />
      </div>
      <SuggestedApps task={bot.task} />
    </div>
  );
}

/** The name as words that turn into a field on a click: ↵ or leaving saves, Esc puts it back. */
function InlineName(props: { bot: RosterBot }) {
  const { bot } = props;
  const edit = useEditBot(bot);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(bot.name);
  const [problem, setProblem] = useState<string>();
  const dropped = useRef(false);
  const save = async () => {
    if (dropped.current) return;
    const name = text.trim();
    if (!name || name === bot.name) return setEditing(false);
    const refused = await edit({ name });
    setProblem(refused);
    if (!refused) setEditing(false);
  };
  if (!editing)
    return (
      <button
        type="button"
        aria-label={`Rename ${bot.name}`}
        onClick={() => {
          dropped.current = false;
          setText(bot.name);
          setProblem(undefined);
          setEditing(true);
        }}
        className="-mx-1 h-7 rounded-md px-1 font-medium text-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-hover"
      >
        {bot.name}
      </button>
    );
  return (
    <span className="flex items-center gap-2">
      <input
        aria-label="Name"
        value={text}
        autoFocus
        maxLength={spadeAgentNameMax}
        aria-invalid={problem ? true : undefined}
        onChange={(event) => setText(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void save();
          } else if (event.key === "Escape") {
            event.stopPropagation();
            dropped.current = true;
            setEditing(false);
          }
        }}
        className="field-sizing-content h-7 min-w-20 rounded-md bg-chat-well px-1.5 font-medium text-foreground shadow-[inset_0_0_0_1px_var(--foreground)] outline-none"
      />
      {problem && (
        <span role="alert" className="text-xs text-destructive">
          {problem}
        </span>
      )}
    </span>
  );
}

/** The most apps the suggestion names. */
const mostApps = 3;

/**
 * The catalogue apps a task names outright ("Gmail", "Slack", "GitHub"), best first, leaving out
 * the ones already connected. Words only, no model call: Spade's own fit
 * (`spade-connect::fit`) replaces this once it answers.
 */
export function appsNamedIn(
  task: string,
  catalogue: readonly SpadeCatalogueEntry[],
  connected: ReadonlySet<string>,
): SpadeCatalogueEntry[] {
  const words = new Set(
    task
      .toLowerCase()
      .split(/[^\p{L}\p{N}.-]+/u)
      .filter(Boolean),
  );
  return catalogue
    .filter((entry) => !connected.has(entry.id))
    .filter((entry) => {
      const name = entry.name.toLowerCase();
      if (task.toLowerCase().includes(name) && name.length > 2) return true;
      return words.has(entry.id.toLowerCase());
    })
    .slice(0, mostApps);
}

/**
 * "It may need Gmail and Slack." with Connect apps, which opens the app list. Nothing when the
 * task names no app that isn't connected. One component, so the bot's own suggestion can take
 * its place.
 */
export function SuggestedApps(props: { task: string }) {
  const connectors = useSpadeConnectors();
  const [adding, setAdding] = useState(false);
  const data = connectors.data;
  if (!data) return null;
  const connected = new Set(
    data.connectors.flatMap((each) => (each.catalogue ? [each.catalogue] : [])),
  );
  const apps = appsNamedIn(props.task, data.catalogue, connected);
  if (apps.length === 0) return null;
  const names = apps.map((app) => app.name);
  const said =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return (
    <div role="note" aria-label={`It may need ${said}`} className={line}>
      <span className="flex items-center gap-1">
        {apps.map((app) => (
          <AppMark key={app.id} catalogue={app.id} name={app.name} size="inline" />
        ))}
      </span>
      <span className="text-muted-foreground">
        It may need <span className="text-foreground">{said}</span>.
      </span>
      <Button variant="ghost" size="sm" className={word} onClick={() => setAdding(true)}>
        Connect apps
      </Button>
      {adding && (
        <AddConnectorDialog
          catalogue={data.catalogue}
          added={
            new Map(
              data.connectors.flatMap((each) =>
                each.catalogue ? [[each.catalogue, spadeConnectorLine(each)] as const] : [],
              ),
            )
          }
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}
