import {
  spadeKnowledgeBodyMax,
  spadeKnowledgeTitleMax,
  type SpadeAgent,
  type SpadeKnowledgeEntry,
} from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import { useNow } from "@/lib/time.ts";
import { SpadeBubbleText } from "./spade-bubble-text.tsx";
import {
  changeKnowledge,
  deleteKnowledge,
  isKnowledgeMoved,
  knowledgeKey,
  readKnowledgeEntry,
} from "./spade-knowledge-api.ts";
import { DocTop, dayWords, leading } from "./spade-library-parts.tsx";
import { SpadeProvenanceDialog } from "./spade-provenance.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { ProfileProblem, rowPill } from "./spade-profile-parts.tsx";
import { agentsKey, type RosterBot } from "./use-spade-roster.ts";

const fault = (error: unknown) => (error instanceof Error ? error.message : "Try again.");

/** A web address as a person reads it: no scheme, no `www.`, no trailing slash. */
const shortUrl = (url: string) => url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

/** How a save went: saved, refused for a reason, or the page moved on first (`now`). */
type Saved =
  | { kind: "saved" }
  | { kind: "failed"; why: string }
  | { kind: "moved"; now: SpadeKnowledgeEntry };

/**
 * A page, open in the Library's place: its title and text edit where they show (the title: ↵
 * saves; the text: ⌘↵ or leaving it saves; Esc puts either back). The line under the title says
 * where it came from (the bot's own work and what for, the person, or a web address) and when;
 * an untrusted page says so, with Trust this. An edit made from a version the bot has since
 * changed is refused, says so, and saves over it on the next try.
 */
export function LibraryPage(props: { bot: RosterBot; id: string; onBack(): void }) {
  const { bot } = props;
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const cache = useQueryClient();
  const toast = useToast();
  const key = [...knowledgeKey, machine, "entry", props.id];
  const page = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => readKnowledgeEntry(client, props.id, signal),
  });
  const [confirming, setConfirming] = useState<Confirming>();
  const [why, setWhy] = useState(false);
  const settle = async (entry?: SpadeKnowledgeEntry) => {
    if (entry) cache.setQueryData(key, entry);
    await cache.invalidateQueries({ queryKey: [...knowledgeKey, machine, bot.id] });
  };
  const save = async (
    change: { title?: string; body?: string; trusted?: true },
    from: number,
  ): Promise<Saved> => {
    try {
      await settle(await changeKnowledge(client, props.id, change, from));
      return { kind: "saved" };
    } catch (error) {
      if (!isKnowledgeMoved(error)) return { kind: "failed", why: fault(error) };
      const now = await readKnowledgeEntry(client, props.id).catch(() => undefined);
      if (!now) return { kind: "failed", why: fault(error) };
      cache.setQueryData(key, now);
      return { kind: "moved", now };
    }
  };
  if (page.isPending)
    return (
      <>
        <DocTop onBack={props.onBack} />
        <div aria-hidden className="h-7 w-2/3 rounded-md bg-hover" />
      </>
    );
  if (!page.data)
    return (
      <>
        <DocTop onBack={props.onBack} />
        <ProfileProblem text="Couldn't read the page." onRetry={() => void page.refetch()} />
      </>
    );
  const entry = page.data;
  const trust = async () => {
    const saved = await save({ trusted: true }, entry.updatedAt);
    if (saved.kind === "failed")
      toast.error({ title: "Couldn't trust the page", description: saved.why });
    // Moved on meanwhile: trusting what it says now is a new choice, so the person makes it.
    if (saved.kind === "moved")
      toast.info({
        title: "The page changed meanwhile",
        description: "Read it again, then trust it.",
      });
  };
  return (
    <article aria-label={entry.title} className="flex flex-col">
      <DocTop onBack={props.onBack}>
        <Button size="sm" variant="ghost" className={rowPill} onClick={() => setWhy(true)}>
          Where it's from
        </Button>
        {!entry.trusted && (
          <Button size="sm" variant="secondary" className={rowPill} onClick={() => void trust()}>
            Trust this
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          tone="danger"
          className={cn(rowPill, "-mr-3")}
          onClick={() =>
            setConfirming({
              title: `Delete “${entry.title}”?`,
              body: `${bot.name} won't be able to look it up any more.`,
              confirm: "Delete page",
              run: () =>
                void deleteKnowledge(client, entry.id)
                  .then(async () => {
                    props.onBack();
                    await settle();
                  })
                  .catch((error: unknown) =>
                    toast.error({ title: "Couldn't delete the page", description: fault(error) }),
                  ),
            })
          }
        >
          Delete
        </Button>
      </DocTop>
      <TitleField entry={entry} onSave={(title, from) => save({ title }, from)} />
      <Origin bot={bot} entry={entry} />
      <BodyField entry={entry} onSave={(body, from) => save({ body }, from)} />
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
      <SpadeProvenanceDialog
        bot={bot.id}
        of={why ? { kind: "entry", id: entry.id } : undefined}
        onForget={async () => {
          await deleteKnowledge(client, entry.id);
          props.onBack();
          await settle();
        }}
        // The page edits in place: its title and body stay open to correct.
        onCorrect={() => undefined}
        onDone={() => setWhy(false)}
      />
    </article>
  );
}

/** Where a page came from and when, and its trust when it isn't trusted. */
function Origin(props: { bot: RosterBot; entry: SpadeKnowledgeEntry }) {
  const { entry } = props;
  const now = useNow();
  const cache = useQueryClient();
  const machine = useSpadeMachine().key;
  const day = dayWords(entry.updatedAt, now);
  const { detail } = entry.source;
  const { author } = entry;
  // A maker's or worker's page names it, from the bots this machine's Spade listed.
  const writer =
    author.kind === "person"
      ? "You"
      : author.bot === props.bot.id
        ? props.bot.name
        : (cache
            .getQueryData<SpadeAgent[]>([...agentsKey, machine])
            ?.find((each) => each.id === author.bot)?.name ?? "Another bot");
  const from =
    entry.source.kind === "web" && detail ? (
      <>
        {"From "}
        <a
          href={detail}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground underline decoration-border-strong underline-offset-3 hover:text-foreground"
        >
          {shortUrl(detail)}
        </a>
        {` · ${day}`}
      </>
    ) : entry.source.kind === "file" && detail ? (
      `From ${detail} · ${day}`
    ) : entry.source.kind === "tool" && detail ? (
      `From ${detail.split(/\s+/)[0]} · ${day}`
    ) : entry.source.kind === "untrusted" ? (
      `From outside${detail ? `: ${detail}` : ""} · ${day}`
    ) : entry.author.kind === "person" ? (
      `You wrote it ${day}`
    ) : (
      `${writer} wrote it ${day}${detail ? ` · for ${detail}` : ""}`
    );
  return (
    <p className="mt-1 text-xs leading-[18px] text-subtle-foreground">
      {from}
      {!entry.trusted && <span className="text-muted-foreground">{" · Untrusted"}</span>}
    </p>
  );
}

/** The title in its own type; editing turns it into its field. ↵ saves, Esc puts it back. */
function TitleField(props: {
  entry: SpadeKnowledgeEntry;
  onSave(title: string, from: number): Promise<Saved>;
}) {
  const { entry } = props;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(entry.title);
  const [problem, setProblem] = useState<string>();
  const base = useRef(entry.updatedAt);
  const type = "text-lg leading-7 font-semibold text-foreground";
  if (!editing)
    return (
      <button
        type="button"
        aria-label={`Edit the title: ${entry.title}`}
        onClick={() => {
          base.current = entry.updatedAt;
          setText(entry.title);
          setProblem(undefined);
          setEditing(true);
        }}
        className={cn("-mx-2 rounded-md px-2 text-left focus-ring hover:bg-hover", type)}
      >
        {entry.title}
      </button>
    );
  const submit = async () => {
    const title = text.trim();
    if (!title || title === entry.title) return setEditing(false);
    const saved = await props.onSave(title, base.current);
    if (saved.kind === "saved") return setEditing(false);
    if (saved.kind === "moved") base.current = saved.now.updatedAt;
    setProblem(saved.kind === "moved" ? "Changed since you opened it" : saved.why);
  };
  return (
    <div className="flex flex-col gap-1">
      <input
        aria-label="Title"
        value={text}
        autoFocus
        maxLength={spadeKnowledgeTitleMax}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => void submit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void submit();
          } else if (event.key === "Escape") {
            event.stopPropagation();
            setEditing(false);
          }
        }}
        className={cn(
          "-mx-2 rounded-md bg-chat-well px-2 shadow-[inset_0_0_0_1px_var(--foreground)] outline-none",
          type,
        )}
      />
      {problem && <Problem>{problem}</Problem>}
    </div>
  );
}

/**
 * The text, as it reads; editing turns it into its field in place. ⌘↵ or leaving the field
 * saves, Esc puts it back. Untouched, the open field follows the page as the bot changes it.
 */
function BodyField(props: {
  entry: SpadeKnowledgeEntry;
  onSave(body: string, from: number): Promise<Saved>;
}) {
  const { entry } = props;
  const [editing, setEditing] = useState(false);
  const [base, setBase] = useState(entry);
  const [text, setText] = useState(entry.body);
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);
  const dropped = useRef(false);
  if (editing && entry.updatedAt !== base.updatedAt && text === base.body) {
    setBase(entry);
    setText(entry.body);
  }
  const open = () => {
    dropped.current = false;
    setBase(entry);
    setText(entry.body);
    setProblem(undefined);
    setEditing(true);
  };
  const submit = async () => {
    if (dropped.current || saving) return;
    const body = text.trim();
    if (!body || body === base.body.trim()) return setEditing(false);
    setSaving(true);
    const saved = await props.onSave(body, base.updatedAt);
    setSaving(false);
    if (saved.kind === "saved") return setEditing(false);
    if (saved.kind === "moved") setBase(saved.now);
    setProblem(
      saved.kind === "moved" ? "Changed since you opened it. Save again to keep yours." : saved.why,
    );
  };
  const prose = "text-md leading-[22px]";
  if (!editing)
    return (
      <div className="group/body relative mt-4">
        <button
          type="button"
          onClick={open}
          className="absolute -top-1 right-0 z-10 rounded-full px-2.5 py-0.5 text-xs font-medium text-muted-foreground opacity-0 focus-ring group-hover/body:opacity-100 focus-visible:opacity-100 hover:bg-hover hover:text-foreground pointer-coarse:opacity-100"
        >
          Edit
        </button>
        {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- the Edit button above is the keyboard's way in; a click on the text is a shortcut to it */}
        <div
          onClick={(event) => {
            if (!(event.target instanceof Element) || !event.target.closest("a, button")) open();
          }}
          className={cn(
            "-mx-2 cursor-text rounded-md px-2 py-1 text-foreground hover:bg-hover",
            prose,
          )}
        >
          <SpadeBubbleText text={entry.body} />
        </div>
      </div>
    );
  return (
    <div className="mt-4 flex flex-col gap-1.5">
      <textarea
        aria-label="Page"
        value={text}
        autoFocus
        disabled={saving}
        maxLength={spadeKnowledgeBodyMax}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => void submit()}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          } else if (event.key === "Escape") {
            event.stopPropagation();
            dropped.current = true;
            setEditing(false);
          }
        }}
        className={cn(
          "-mx-2.5 min-h-32 resize-none rounded-md bg-chat-well px-3 py-2.5 text-foreground shadow-[inset_0_0_0_1px_var(--foreground)] outline-none [field-sizing:content]",
          prose,
        )}
      />
      {problem && <Problem>{problem}</Problem>}
    </div>
  );
}

function Problem(props: { children: string }) {
  return (
    <p role="alert" className="text-xs text-(--status-needs-you-text)">
      {leading(props.children)}
    </p>
  );
}
