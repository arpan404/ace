import { FileIcon, FolderIcon, MagnifyingGlassIcon, StackIcon, XIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useRef, type ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";
import { SettingList, SettingListItem } from "@/components/setting-row.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useNow } from "@/lib/time.ts";
import type { FilesAt } from "./computer/profile-computer.tsx";
import { knowledgeKey, readEpisodes, readKnowledge } from "./spade-knowledge-api.ts";
import { LibraryRow, Marked, plainLine } from "./spade-library-parts.tsx";
import { episodeLine, newestClosed } from "./spade-library-past.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { notesKey } from "./spade-notes.tsx";
import { readNotes } from "./spade-notes-api.ts";
import { ProfileEmpty, ProfileProblem, ProfileSection } from "./spade-profile-parts.tsx";
import { readSkillStore } from "./spade-skills-api.ts";
import { readFolder } from "./spade-workspace-api.ts";
import type { RosterBot } from "./use-spade-roster.ts";

/** The one search over everything the bot keeps: a pill at the Library's top. Esc clears it. */
export function LibrarySearchField(props: {
  bot: RosterBot;
  value: string;
  onChange(value: string): void;
}) {
  const field = useRef<HTMLInputElement>(null);
  return (
    <div className="mb-1 flex h-(--spade-pill-button) items-center gap-2 rounded-full bg-surface-1 pr-1 pl-3 text-subtle-foreground has-focus-visible:shadow-[inset_0_0_0_1px_var(--foreground)]">
      <Icon icon={MagnifyingGlassIcon} size={16} />
      <input
        ref={field}
        type="search"
        aria-label={`Search what ${props.bot.name} knows`}
        placeholder={`Search what ${props.bot.name} knows`}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && props.value) {
            event.stopPropagation();
            props.onChange("");
          }
        }}
        className="min-w-0 flex-1 bg-transparent text-ui text-foreground outline-none placeholder:text-subtle-foreground [&::-webkit-search-cancel-button]:hidden"
      />
      {props.value && (
        <button
          type="button"
          aria-label="Clear the search"
          onClick={() => {
            props.onChange("");
            field.current?.focus();
          }}
          className="grid size-7 place-items-center rounded-full text-muted-foreground focus-ring hover:bg-hover hover:text-foreground"
        >
          <Icon icon={XIcon} size={14} />
        </button>
      )}
    </div>
  );
}

const has = (text: string, query: string) => text.toLowerCase().includes(query.toLowerCase());

/**
 * What matches `query` across the Library, in its own groups (Notes, Pages, Past work, Files,
 * Skills), empty ones left out; nothing anywhere says so once.
 */
export function LibraryResults(props: {
  bot: RosterBot;
  query: string;
  onOpenPage(id: string): void;
  onOpenEpisode(id: string): void;
  onOpenFile(files: FilesAt): void;
}) {
  const { bot, query } = props;
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const now = useNow();
  const notes = useQuery({
    queryKey: [...notesKey, machine, bot.id, "search", query],
    queryFn: ({ signal }) => readNotes(client, { kind: "agent", agent: bot.id }, { query, signal }),
  });
  const shared = useQuery({
    queryKey: [...notesKey, machine, "shared", "search", query],
    queryFn: ({ signal }) => readNotes(client, { kind: "shared" }, { query, signal }),
    enabled: bot.kind === "main",
  });
  const pages = useQuery({
    queryKey: [...knowledgeKey, machine, bot.id, "pages", query],
    queryFn: ({ signal }) => readKnowledge(client, bot.id, { query, signal }),
  });
  const past = useQuery({
    queryKey: [...knowledgeKey, machine, bot.id, "episodes", query],
    queryFn: ({ signal }) => readEpisodes(client, bot.id, { query, signal }),
  });
  // Files and skills are few: the lists the Library already read, matched by name here.
  const files = useQuery({
    queryKey: ["spade", "workspace", machine, bot.id, ""],
    queryFn: ({ signal }) => readFolder(client, bot.id, "", { signal }),
  });
  const skills = useQuery({
    queryKey: ["spade", "skill-store", machine],
    queryFn: ({ signal }) => readSkillStore(client, { signal }),
  });
  const reads = [notes, pages, past, files, skills, ...(bot.kind === "main" ? [shared] : [])];
  if (reads.some((read) => read.isPending && read.fetchStatus !== "idle"))
    return <ListSkeleton label="results" shape="row" rows={3} />;
  const failed = reads.find((read) => read.isError);
  const noteHits = [...(shared.data ?? []), ...(notes.data ?? [])].filter(
    (note) => !note.suggested,
  );
  const pageHits = pages.data ?? [];
  const pastHits = newestClosed(past.data ?? []);
  const fileHits = (files.data?.entries ?? []).filter((entry) => has(entry.name, query));
  const skillHits = (skills.data?.skills ?? []).filter(
    (skill) =>
      (skill.usedBy.includes(bot.id) || skill.writtenBy.includes(bot.id)) &&
      (has(skill.name, query) || has(skill.description, query)),
  );
  const nothing =
    noteHits.length + pageHits.length + pastHits.length + fileHits.length + skillHits.length === 0;
  return (
    <>
      {failed && (
        <ProfileProblem
          text="Couldn't search all of it."
          onRetry={() => reads.forEach((read) => void read.refetch())}
        />
      )}
      {nothing && !failed && (
        <ProfileEmpty className="mx-1">{`Nothing matches “${query}”.`}</ProfileEmpty>
      )}
      <Group label="Notes" shown={noteHits.length > 0}>
        <SettingList aria-label="Notes">
          {noteHits.map((note) => (
            <SettingListItem key={note.id} className="text-ui wrap-anywhere text-foreground">
              <Marked text={note.text} query={query} />
            </SettingListItem>
          ))}
        </SettingList>
      </Group>
      <Group label="Pages" shown={pageHits.length > 0}>
        <SettingList aria-label="Pages">
          {pageHits.map((page) => (
            <LibraryRow
              key={page.id}
              title={page.title}
              line={plainLine(page.body)}
              mark={query}
              at={page.updatedAt}
              now={now}
              onOpen={() => props.onOpenPage(page.id)}
            />
          ))}
        </SettingList>
      </Group>
      <Group label="Past work" shown={pastHits.length > 0}>
        <SettingList aria-label="Past work">
          {pastHits.map((episode) => (
            <LibraryRow
              key={episode.id}
              title={episode.title}
              line={episodeLine(episode)}
              mark={query}
              at={episode.closedAt}
              now={now}
              onOpen={() => props.onOpenEpisode(episode.id)}
            />
          ))}
        </SettingList>
      </Group>
      <Group label="Files" shown={fileHits.length > 0}>
        {fileHits.map((entry) => (
          <button
            key={entry.path}
            type="button"
            data-setting-slot=""
            onClick={() =>
              props.onOpenFile(
                entry.kind === "folder" ? { folder: entry.path } : { folder: "", file: entry.path },
              )
            }
            className="flex min-h-11 min-w-0 items-center gap-3 py-2 text-left text-ui text-foreground focus-ring hover:underline"
          >
            <Icon
              icon={entry.kind === "folder" ? FolderIcon : FileIcon}
              size={16}
              className="text-muted-foreground"
            />
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          </button>
        ))}
      </Group>
      <Group label="Skills" shown={skillHits.length > 0}>
        {skillHits.map((skill) => (
          <div
            key={skill.id}
            data-setting-slot=""
            className="flex min-h-11 min-w-0 items-center gap-3 py-2 text-ui text-foreground"
          >
            <Icon icon={StackIcon} size={16} className="text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{skill.name}</span>
          </div>
        ))}
      </Group>
    </>
  );
}

function Group(props: { label: string; shown: boolean; children: ReactNode }) {
  return props.shown ? <ProfileSection label={props.label}>{props.children}</ProfileSection> : null;
}
