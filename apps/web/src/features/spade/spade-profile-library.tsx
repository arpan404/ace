import { formatAge } from "@ace/ui-core/time";
import { FileIcon, FolderIcon, StackIcon } from "@ace/icons";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { searchSettleMs, useDebouncedValue } from "@/lib/debounced.ts";
import { useNow } from "@/lib/time.ts";
import { part } from "@/lib/suit-part.ts";
import type { FilesAt } from "./computer/profile-computer.tsx";
import { LibraryPage } from "./spade-library-page.tsx";
import { LibraryLearnedFrom } from "./spade-provenance.tsx";
import { LibraryPages } from "./spade-library-pages.tsx";
import { LibraryEpisode, LibraryPast } from "./spade-library-past.tsx";
import { LibraryResults, LibrarySearchField } from "./spade-library-search.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { SpadeNotes } from "./spade-notes.tsx";
import { ProfileNone, ProfileProblem, ProfileSection, rowPill } from "./spade-profile-parts.tsx";
import { readSkillStore, type SpadeStoredSkill } from "./spade-skills-api.ts";
import { readFolder } from "./spade-workspace-api.ts";
import type { RosterBot } from "./use-spade-roster.ts";

/** Files shown before All files. */
const shownFiles = 5;

/** What the Library has open in its place: a page or a piece of past work. */
type Open = { kind: "page"; id: string } | { kind: "episode"; id: string };

/**
 * Library: what the bot keeps (ADR 0164). One search over all of it, then its notes (what it
 * always keeps in mind; Spade's own Library starts with About you, the notes every bot reads),
 * its pages (what it looks up), its past work (a summary per goal it closed), the files at the
 * top of its workspace, and the skills it wrote or uses. A page or a piece of past work opens
 * in the Library's place, with ‹ Library back to where the person was.
 */
export function ProfileLibrary(props: { bot: RosterBot; onOpenFile(files: FilesAt): void }) {
  const { bot } = props;
  const [typed, setTyped] = useState("");
  const query = useDebouncedValue(typed.trim(), searchSettleMs);
  const [open, setOpen] = useState<Open>();
  const back = () => setOpen(undefined);
  if (open?.kind === "page") return <LibraryPage bot={bot} id={open.id} onBack={back} />;
  if (open?.kind === "episode") return <LibraryEpisode bot={bot} id={open.id} onBack={back} />;
  const openPage = (id: string) => setOpen({ kind: "page", id });
  const openEpisode = (id: string) => setOpen({ kind: "episode", id });
  return (
    <>
      <LibrarySearchField bot={bot} value={typed} onChange={setTyped} />
      {typed.trim() && query ? (
        <LibraryResults
          bot={bot}
          query={query}
          onOpenPage={openPage}
          onOpenEpisode={openEpisode}
          onOpenFile={props.onOpenFile}
        />
      ) : (
        <>
          {bot.kind === "main" && (
            <SpadeNotes
              scope={{ kind: "shared" }}
              heading="About you"
              label="About you"
              placeholder="Add something every bot should know about you"
              bot={bot.id}
            />
          )}
          <SpadeNotes
            scope={{ kind: "agent", agent: bot.id }}
            heading="Notes"
            label={`${bot.name}'s memory`}
            placeholder={`Add something for ${bot.name} to remember`}
            bot={bot.id}
          />
          <LibraryPages bot={bot} onOpen={openPage} />
          <LibraryLearnedFrom bot={bot} />
          <LibraryPast bot={bot} onOpen={openEpisode} />
          <Files bot={bot} onOpen={props.onOpenFile} />
          <Skills bot={bot} />
        </>
      )}
    </>
  );
}

/** The top of its workspace, newest kept first; a file or folder opens in Computer's Files. */
function Files(props: { bot: RosterBot; onOpen(files: FilesAt): void }) {
  const { bot } = props;
  const client = useSpadeClient();
  const machine = useSpadeMachine();
  const now = useNow();
  const listing = useQuery({
    queryKey: ["spade", "workspace", machine.key, bot.id, ""],
    queryFn: ({ signal }) => readFolder(client, bot.id, "", { signal }),
  });
  const entries = listing.data?.entries ?? [];
  return (
    <ProfileSection
      label="Files"
      bare={listing.isSuccess && entries.length === 0}
      actions={
        entries.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className={rowPill}
            onClick={() => props.onOpen({ folder: "" })}
          >
            All files
          </Button>
        )
      }
    >
      {listing.isPending ? (
        <ListSkeleton label="files" shape="row" rows={2} />
      ) : listing.isError ? (
        <ProfileProblem text="Couldn't read the files." onRetry={() => void listing.refetch()} />
      ) : entries.length === 0 ? (
        <ProfileNone>{`${bot.name} hasn't kept any files yet.`}</ProfileNone>
      ) : (
        entries.slice(0, shownFiles).map((entry) => (
          <button
            key={entry.path}
            type="button"
            data-setting-slot=""
            {...part("list-row", undefined, entry.kind)}
            onClick={() =>
              props.onOpen(
                entry.kind === "folder" ? { folder: entry.path } : { folder: "", file: entry.path },
              )
            }
            className="group/file flex min-h-11 min-w-0 items-center gap-3 rounded-sm py-2 text-left text-ui text-foreground focus-ring"
          >
            <Icon
              icon={entry.kind === "folder" ? FolderIcon : FileIcon}
              size={16}
              className="shrink-0 text-muted-foreground"
            />
            <span className="min-w-0 flex-1 truncate group-hover/file:underline">{entry.name}</span>
            {entry.modifiedAt !== undefined && (
              <span className="shrink-0 text-xs text-subtle-foreground tabular-nums">
                {formatAge(entry.modifiedAt, now)}
              </span>
            )}
          </button>
        ))
      )}
    </ProfileSection>
  );
}

/** Whether the bot wrote a skill or only uses it. */
const skillWord = (skill: SpadeStoredSkill, bot: string) =>
  skill.writtenBy.includes(bot)
    ? "Wrote it"
    : skill.origin === "plugin"
      ? "From a plugin"
      : "Uses it";

/** The skills it wrote or loaded, from Spade's skill store; none: one line. */
function Skills(props: { bot: RosterBot }) {
  const { bot } = props;
  const client = useSpadeClient();
  const machine = useSpadeMachine();
  const store = useQuery({
    queryKey: ["spade", "skill-store", machine.key],
    queryFn: ({ signal }) => readSkillStore(client, { signal }),
  });
  const mine =
    store.data?.skills.filter(
      (skill) => skill.usedBy.includes(bot.id) || skill.writtenBy.includes(bot.id),
    ) ?? [];
  return (
    <ProfileSection label="Skills" bare={store.isSuccess && mine.length === 0}>
      {store.isPending ? (
        <ListSkeleton label="skills" shape="row" rows={1} />
      ) : store.isError ? (
        <ProfileProblem text="Couldn't read the skills." onRetry={() => void store.refetch()} />
      ) : mine.length === 0 ? (
        <ProfileNone>{`${bot.name} hasn't used a skill yet.`}</ProfileNone>
      ) : (
        mine.map((skill) => (
          <div
            key={skill.id}
            data-setting-slot=""
            title={skill.description || undefined}
            className="flex min-h-11 min-w-0 items-center gap-3 py-2 text-ui text-foreground"
          >
            <Icon icon={StackIcon} size={16} className="shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{skill.name}</span>
            <span className="shrink-0 text-xs text-subtle-foreground">
              {skillWord(skill, bot.id)}
            </span>
          </div>
        ))
      )}
    </ProfileSection>
  );
}
