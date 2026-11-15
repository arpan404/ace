import { formatAge } from "@ace/ui-core/time";
import { FileIcon, FolderIcon, StackIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useNow } from "@/lib/time.ts";
import type { FilesAt } from "./computer/profile-computer.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { SpadeNotes } from "./spade-notes.tsx";
import { ProfileEmpty, ProfileProblem, ProfileSection, rowPill } from "./spade-profile-parts.tsx";
import { readSkillStore, type SpadeStoredSkill } from "./spade-skills-api.ts";
import { readFolder } from "./spade-workspace-api.ts";
import type { RosterBot } from "./use-spade-roster.ts";

/** Files shown before All files. */
const shownFiles = 5;

/**
 * Library: what the bot keeps. Its notes (its memory; Spade's own Library starts with About you,
 * the notes every bot reads), the files at the top of its workspace, and the skills it wrote or
 * uses.
 */
export function ProfileLibrary(props: { bot: RosterBot; onOpenFile(files: FilesAt): void }) {
  const { bot } = props;
  return (
    <>
      {bot.kind === "main" && (
        <SpadeNotes
          scope={{ kind: "shared" }}
          heading="About you"
          label="About you"
          placeholder="Add something every bot should know about you"
        />
      )}
      <SpadeNotes
        scope={{ kind: "agent", agent: bot.id }}
        heading="Notes"
        label={`${bot.name}'s memory`}
        placeholder={`Add something for ${bot.name} to remember`}
      />
      <Files bot={bot} onOpen={props.onOpenFile} />
      <Skills bot={bot} />
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
        <ProfileEmpty>{`${bot.name} hasn't kept any files yet.`}</ProfileEmpty>
      ) : (
        entries.slice(0, shownFiles).map((entry) => (
          <button
            key={entry.path}
            type="button"
            data-setting-slot=""
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
    <ProfileSection label="Skills">
      {store.isPending ? (
        <ListSkeleton label="skills" shape="row" rows={1} />
      ) : store.isError ? (
        <ProfileProblem text="Couldn't read the skills." onRetry={() => void store.refetch()} />
      ) : mine.length === 0 ? (
        <ProfileEmpty>{`${bot.name} hasn't used a skill yet.`}</ProfileEmpty>
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
