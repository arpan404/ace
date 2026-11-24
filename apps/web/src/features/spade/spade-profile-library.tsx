import { spadeSkillsOf } from "@ace/ui-core/spade-chat";
import { StackIcon } from "@ace/icons";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { searchSettleMs, useDebouncedValue } from "@/lib/debounced.ts";
import type { FilesAt } from "./computer/profile-computer.tsx";
import { LibraryFiles } from "./spade-library-files.tsx";
import { LibraryPage } from "./spade-library-page.tsx";
import { LibraryLearnedFrom } from "./spade-provenance.tsx";
import { LibraryPages } from "./spade-library-pages.tsx";
import { LibraryEpisode, LibraryPast } from "./spade-library-past.tsx";
import { LibraryResults, LibrarySearchField } from "./spade-library-search.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { SpadeNotes } from "./spade-notes.tsx";
import {
  ProfileCardSkeleton,
  ProfileNone,
  ProfileProblem,
  ProfileSection,
} from "./spade-profile-parts.tsx";
import { readSkillStore } from "./spade-skills-api.ts";
import type { RosterBot } from "./use-spade-roster.ts";

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
          onClear={() => setTyped("")}
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
          <LibraryFiles bot={bot} onOpen={props.onOpenFile} />
          <Skills bot={bot} />
        </>
      )}
    </>
  );
}

/** The skills it wrote or loaded, from Spade's skill store; none: one rounded empty row. */
function Skills(props: { bot: RosterBot }) {
  const { bot } = props;
  const client = useSpadeClient();
  const machine = useSpadeMachine();
  const store = useQuery({
    queryKey: ["spade", "skill-store", machine.key],
    queryFn: ({ signal }) => readSkillStore(client, { signal }),
  });
  const mine = store.data ? spadeSkillsOf(store.data, bot.id) : [];
  const empty = store.isSuccess && mine.length === 0;
  const failed = store.isError;
  return (
    <ProfileSection label="Skills" bare={empty || failed} flush={!empty && !failed}>
      {store.isPending ? (
        <ProfileCardSkeleton label="skills" leading="icon" rows={1} />
      ) : failed ? (
        <ProfileProblem
          card
          text="Couldn't read the skills."
          onRetry={() => void store.refetch()}
        />
      ) : empty ? (
        <ProfileNone>{`${bot.name} hasn't used a skill yet.`}</ProfileNone>
      ) : (
        mine.map(({ skill, word }) => (
          <div
            key={skill.id}
            data-setting-slot=""
            title={skill.description || undefined}
            className="flex min-h-11 min-w-0 items-center gap-3 px-4 py-2.5 text-ui text-foreground transition-colors duration-(--motion-fast) hover:bg-hover"
          >
            <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
              <Icon icon={StackIcon} size={16} />
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">{skill.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{word}</span>
          </div>
        ))
      )}
    </ProfileSection>
  );
}
