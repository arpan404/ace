import {
  spadeKnowledgeBodyMax,
  spadeKnowledgeTitleMax,
  type SpadeKnowledgeEntry,
  type SpadeKnowledgeMerge,
} from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SettingAddRow, SettingList, SettingListItem } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useNow } from "@/lib/time.ts";
import {
  addKnowledge,
  knowledgeKey,
  mergeKnowledge,
  readKnowledge,
  readKnowledgeMerges,
} from "./spade-knowledge-api.ts";
import { LibraryRow, plainLine, topicOf } from "./spade-library-parts.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { ProfileEmpty, ProfileProblem, ProfileSection, rowPill } from "./spade-profile-parts.tsx";
import type { RosterBot } from "./use-spade-roster.ts";

/** Pages shown before Show all. */
const shownPages = 6;

const fault = (error: unknown) => (error instanceof Error ? error.message : "Try again.");

/**
 * Pages: what the bot looks things up in, newest change first. Two pages alike enough to be one
 * wait at the top with Keep both and Merge; Add a page writes one in place.
 */
export function LibraryPages(props: { bot: RosterBot; onOpen(id: string): void }) {
  const { bot } = props;
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const now = useNow();
  const [all, setAll] = useState(false);
  const pages = useQuery({
    queryKey: [...knowledgeKey, machine, bot.id, "pages", ""],
    queryFn: ({ signal }) => readKnowledge(client, bot.id, { signal }),
  });
  const entries = pages.data ?? [];
  const shown = all ? entries : entries.slice(0, shownPages);
  return (
    <ProfileSection
      label="Pages"
      actions={
        entries.length > shownPages && (
          <Button size="sm" variant="ghost" className={rowPill} onClick={() => setAll(!all)}>
            {all ? "Show fewer" : `All ${entries.length}`}
          </Button>
        )
      }
    >
      {pages.isPending ? (
        <ListSkeleton label="pages" shape="row" rows={2} />
      ) : pages.isError && !pages.data ? (
        <ProfileProblem text="Couldn't read the pages." onRetry={() => void pages.refetch()} />
      ) : (
        <>
          <Merges bot={bot} pages={entries} />
          {entries.length === 0 ? (
            <ProfileEmpty>No pages yet.</ProfileEmpty>
          ) : (
            <SettingList aria-label={`${bot.name}'s pages`}>
              {shown.map((page) => (
                <LibraryRow
                  key={page.id}
                  title={page.title}
                  line={plainLine(page.body)}
                  at={page.updatedAt}
                  now={now}
                  onOpen={() => props.onOpen(page.id)}
                />
              ))}
            </SettingList>
          )}
          <AddPage bot={bot} onAdded={props.onOpen} />
        </>
      )}
    </ProfileSection>
  );
}

/** Pairs Spade finds alike: Merge folds the older into the newer; Keep both hides the pair here. */
function Merges(props: { bot: RosterBot; pages: SpadeKnowledgeEntry[] }) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const cache = useQueryClient();
  const toast = useToast();
  const [kept, setKept] = useState<readonly string[]>([]);
  const merges = useQuery({
    queryKey: [...knowledgeKey, machine, props.bot.id, "merges"],
    queryFn: ({ signal }) => readKnowledgeMerges(client, props.bot.id, signal),
  });
  const byId = new Map(props.pages.map((page) => [page.id, page]));
  const pairs = (merges.data ?? []).flatMap((pair: SpadeKnowledgeMerge) => {
    const a = byId.get(pair.a);
    const b = byId.get(pair.b);
    if (!a || !b || kept.includes(`${a.id}+${b.id}`)) return [];
    // The newer page keeps its place and takes the older one in.
    return [a.updatedAt >= b.updatedAt ? { into: a, from: b } : { into: b, from: a }];
  });
  if (pairs.length === 0) return null;
  const merge = async (into: string, from: string) => {
    try {
      await mergeKnowledge(client, into, from);
    } catch (error) {
      toast.error({ title: "Couldn't merge the pages", description: fault(error) });
    }
    await cache.invalidateQueries({ queryKey: [...knowledgeKey, machine, props.bot.id] });
  };
  return (
    <SettingList aria-label="Alike pages">
      {pairs.map(({ into, from }) => (
        <SettingListItem
          key={`${into.id}+${from.id}`}
          className="flex-col items-stretch gap-1 py-3"
        >
          <span className="text-ui text-muted-foreground">
            {`“${into.title}” and “${from.title}” say much the same`}
          </span>
          <span className="-mr-3 flex justify-end gap-1">
            <Button
              size="sm"
              variant="ghost"
              className={rowPill}
              onClick={() => setKept([...kept, `${into.id}+${from.id}`, `${from.id}+${into.id}`])}
            >
              Keep both
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className={rowPill}
              onClick={() => void merge(into.id, from.id)}
            >
              Merge
            </Button>
          </span>
        </SettingListItem>
      ))}
    </SettingList>
  );
}

/** A page the person writes, in place: its title, then its text. ⌘↵ adds it, Esc gives up. */
function AddPage(props: { bot: RosterBot; onAdded(id: string): void }) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);
  const close = () => {
    setOpen(false);
    setTitle("");
    setBody("");
    setProblem(undefined);
  };
  if (!open) return <SettingAddRow onClick={() => setOpen(true)}>Add a page</SettingAddRow>;
  const ready = title.trim() !== "" && body.trim() !== "" && !saving;
  const add = async () => {
    if (!ready) return;
    setSaving(true);
    setProblem(undefined);
    try {
      const page = await addKnowledge(client, props.bot.id, {
        topic: topicOf(title),
        title: title.trim(),
        body: body.trim(),
      });
      await cache.invalidateQueries({ queryKey: [...knowledgeKey, machine, props.bot.id] });
      close();
      props.onAdded(page.id);
    } catch (error) {
      setProblem(fault(error));
    } finally {
      setSaving(false);
    }
  };
  const keys = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void add();
    }
  };
  return (
    <form
      data-setting-slot=""
      className="flex flex-col gap-2 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
    >
      <Input
        aria-label="Title"
        placeholder="Title"
        value={title}
        autoFocus
        maxLength={spadeKnowledgeTitleMax}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={keys}
      />
      <textarea
        aria-label="Page"
        placeholder={`What ${props.bot.name} should be able to look up`}
        value={body}
        rows={3}
        maxLength={spadeKnowledgeBodyMax}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={keys}
        className="min-h-20 resize-none rounded-md bg-chat-well px-3 py-2 text-ui text-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none [field-sizing:content] placeholder:text-subtle-foreground focus:shadow-[inset_0_0_0_1px_var(--foreground)]"
      />
      {problem && (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
      <div className="-mr-3 flex justify-end gap-1">
        <Button size="sm" variant="ghost" className={rowPill} onClick={close}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="ghost" className={rowPill} disabled={!ready}>
          {saving ? "Adding…" : "Add"}
        </Button>
      </div>
    </form>
  );
}
