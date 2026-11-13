import { botFaceStateOf } from "@ace/ui-core/bot-face";
import {
  spadeActivityWords,
  spadeHostOf,
  spadeMoney,
  spadeSurfaceNames,
  type SpadeSurface,
} from "@ace/ui-core/spade-chat";
import { formatAge, formatAgo } from "@ace/ui-core/time";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { Icon } from "@/components/icon.tsx";
import { SettingCard, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useNow } from "@/lib/time.ts";
import { surfaceIcons } from "./computer/computer-view.tsx";
import { BotScreen, deleting, useOpenBot } from "./spade-bot-screen.tsx";
import { EditBotDialog } from "./spade-bot-dialog.tsx";
import { SpadeFace } from "./spade-face.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { SpadeNotes } from "./spade-notes.tsx";
import { RoutineDialog } from "./spade-routine-dialogs.tsx";
import { RoutineFacts } from "./spade-routines.tsx";
import { readActivity } from "./spade-oversight-api.ts";
import { editRoutine } from "./spade-routines-api.ts";
import { message } from "./spade-screen-parts.tsx";
import { readFolder } from "./spade-workspace-api.ts";
import { useDeleteBot, useDuplicateBot, useExportBot } from "./use-bot-actions.ts";
import { useSpadeModels, useSpadeSubscriptions } from "./use-spade-models.ts";
import type { RosterBot } from "./use-spade-roster.ts";
import { useSpadeRoutines } from "./use-spade-routines.ts";

/**
 * A bot's own page, opened from its name: its face, name, machine and model, its task, then Edit,
 * Duplicate, Export and Delete; and its sections: Computer (what it used last, to open), Routines
 * (each with its switch), Memory (edited in place), Files, Activity and Spending.
 */
export function BotPage(props: { bot: RosterBot }) {
  const { bot } = props;
  const openBot = useOpenBot(bot);
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>();
  const remove = useDeleteBot();
  const duplicate = useDuplicateBot();
  const exportBot = useExportBot();
  const main = bot.kind === "main";
  const model = useModelName(bot.model);
  return (
    <BotScreen
      bot={bot}
      page
      actions={
        <Button size="sm" variant="ghost" onClick={() => openBot()}>
          Chat
        </Button>
      }
    >
      <div className="h-full overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-5 py-8 sm:px-10">
          <header className="flex flex-col gap-4">
            <div className="flex items-center gap-4">
              <SpadeFace avatar={bot.avatar} size={64} state={botFaceStateOf(bot)} />
              <div className="flex min-w-0 flex-col">
                <h2 className="truncate text-xl font-semibold text-foreground">{bot.name}</h2>
                <p className="truncate text-ui text-muted-foreground">
                  {[bot.machine.name, model].filter(Boolean).join(" · ")}
                </p>
              </div>
            </div>
            {bot.task && <p className="text-md text-foreground">{bot.task}</p>}
            <div className="-ml-2.5 flex items-center gap-1">
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void duplicate(bot).then((copy) => {
                    if (copy)
                      void navigate({
                        to: "/spade/$agentId",
                        params: { agentId: copy.id },
                        search: bot.machine.primary ? {} : { on: bot.machine.key },
                      });
                  })
                }
              >
                Duplicate
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void exportBot(bot)}>
                Export
              </Button>
              {!main && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto text-destructive"
                  onClick={() => setConfirming(deleting(bot, remove, navigate))}
                >
                  Delete
                </Button>
              )}
            </div>
          </header>
          <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-8">
              <ComputerSection bot={bot} />
              <RoutinesSection bot={bot} />
              <SettingSection label="Memory">
                <SpadeNotes
                  scope={{ kind: "agent", agent: bot.id }}
                  label={`${bot.name}'s memory`}
                  placeholder={`Add something for ${bot.name} to remember`}
                />
              </SettingSection>
            </div>
            <div className="flex min-w-0 flex-col gap-8">
              <FilesSection bot={bot} />
              <ActivitySection bot={bot} />
              <SpendingSection bot={bot} onEdit={() => setEditing(true)} />
            </div>
          </div>
        </div>
      </div>
      {editing && <EditBotDialog bot={bot} onClose={() => setEditing(false)} />}
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </BotScreen>
  );
}

/** "GPT-6.1 Mini" for `openrouter/openai/gpt-6.1-mini`, as its endpoint or subscription names it. */
function useModelName(model: string): string | undefined {
  const endpoints = useSpadeModels(true).data?.endpoints;
  const subscriptions = useSpadeSubscriptions(true).data?.providers;
  if (model.startsWith("cli:")) {
    const [provider = "", id = ""] = model.slice(4).split("/");
    const named = subscriptions
      ?.find((each) => each.provider === provider.split("@")[0])
      ?.models.find((each) => each.id === id)?.name;
    return named ?? id;
  }
  const [endpoint, ...rest] = model.split("/");
  const id = rest.join("/");
  const named = endpoints
    ?.find((each) => each.id === endpoint)
    ?.models.find((each) => each.id === id)?.name;
  return named ?? (id || undefined);
}

/** What the bot's computer did last: each surface it used, live or when, with Open. */
function ComputerSection(props: { bot: RosterBot }) {
  const openBot = useOpenBot(props.bot);
  const now = useNow();
  const used = (props.bot.computer?.surfaces ?? []).filter(
    (surface) => surface.kind !== "files" && (surface.live || surface.last !== undefined),
  );
  return (
    <SettingSection label="Computer">
      {used.length === 0 ? (
        <SettingRow
          title={`${props.bot.name} hasn't used its computer yet`}
          description="Its browser, screen and terminal show here once it does."
        />
      ) : (
        used.map((surface) => (
          <SettingRow
            key={surface.kind}
            inline
            title={
              <span className="flex items-center gap-2">
                <Icon icon={surfaceIcons[surface.kind]} size={16} />
                {spadeSurfaceNames[surface.kind]}
              </span>
            }
            description={surfaceFacts(surface, now)}
          >
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Open ${spadeSurfaceNames[surface.kind]}`}
              onClick={() => openBot({ computer: surface.kind })}
            >
              Open
            </Button>
          </SettingRow>
        ))
      )}
    </SettingSection>
  );
}

/** "Live now", or "Last on staybook.com · 3m ago". */
function surfaceFacts(surface: SpadeSurface, now: number): string {
  if (surface.live) return surface.title ? `Live now · ${surface.title}` : "Live now";
  const where = surface.kind === "browser" ? spadeHostOf(surface.url) : surface.title;
  const when = surface.last === undefined ? undefined : formatAgo(surface.last, now);
  return [where && `Last on ${where}`, when].filter(Boolean).join(" · ");
}

/** Each routine with its schedule and its switch; New adds one; all of it on Routines. */
function RoutinesSection(props: { bot: RosterBot }) {
  const { bot } = props;
  const openBot = useOpenBot(bot);
  const { routines, client, refresh } = useSpadeRoutines(bot.id);
  const [adding, setAdding] = useState(false);
  const toast = useToast();
  const now = useNow();
  return (
    <SettingSection
      label="Routines"
      actions={
        <>
          <Button size="xs" variant="ghost" onClick={() => setAdding(true)}>
            New
          </Button>
          <Button size="xs" variant="ghost" onClick={() => openBot({ view: "routines" })}>
            All
          </Button>
        </>
      }
    >
      {routines.isPending ? (
        <ListSkeleton label="routines" shape="row" rows={2} />
      ) : routines.isError ? (
        <SettingRow title="Couldn't read the routines" description={routines.error.message}>
          <Button size="sm" onClick={() => void routines.refetch()}>
            Try again
          </Button>
        </SettingRow>
      ) : routines.data.length === 0 ? (
        <SettingRow title="No routines yet" description={`${bot.name} runs only when you write.`} />
      ) : (
        routines.data.map((routine) => (
          <SettingRow
            key={routine.id}
            inline
            title={routine.name}
            description={<RoutineFacts routine={routine} now={now} />}
          >
            <Switch
              aria-label={routine.name}
              checked={!routine.paused}
              onCheckedChange={(on) =>
                void editRoutine(client, routine.id, { paused: !on }).then(
                  () => refresh(),
                  (error: unknown) =>
                    toast.error({
                      title: on
                        ? `Couldn't resume ${routine.name}`
                        : `Couldn't pause ${routine.name}`,
                      description: message(error),
                    }),
                )
              }
            />
          </SettingRow>
        ))
      )}
      {adding && (
        <RoutineDialog
          agent={bot.id}
          routine={undefined}
          onClose={() => setAdding(false)}
          onSaved={() => void refresh()}
        />
      )}
    </SettingSection>
  );
}

/** The files at the top of its workspace; a file opens in the computer's file manager. */
function FilesSection(props: { bot: RosterBot }) {
  const { bot } = props;
  const client = useSpadeClient();
  const machine = useSpadeMachine();
  const openBot = useOpenBot(bot);
  const now = useNow();
  const listing = useQuery({
    queryKey: ["spade", "workspace", machine.key, bot.id, ""],
    queryFn: ({ signal }) => readFolder(client, bot.id, "", { signal }),
  });
  const shown = listing.data?.entries.slice(0, 5) ?? [];
  return (
    <SettingSection
      label="Files"
      actions={
        <Button size="xs" variant="ghost" onClick={() => openBot({ computer: "files" })}>
          All
        </Button>
      }
    >
      {listing.isPending ? (
        <ListSkeleton label="files" shape="row" rows={2} />
      ) : listing.isError ? (
        <SettingRow title="Couldn't read the files" description={message(listing.error)} />
      ) : shown.length === 0 ? (
        <SettingRow title={`${bot.name} hasn't kept any files yet`} />
      ) : (
        <SettingCard>
          {shown.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() =>
                entry.kind === "folder"
                  ? openBot({ computer: "files", files: entry.path })
                  : openBot({ computer: "files", files: "", file: entry.path })
              }
              className="flex h-12 min-w-0 items-center gap-3 text-left text-md focus-ring-inset"
            >
              <span className="min-w-0 flex-1 truncate">
                {entry.name}
                {entry.kind === "folder" ? "/" : ""}
              </span>
              {entry.modifiedAt !== undefined && (
                <span className="shrink-0 text-meta text-muted-foreground tabular-nums">
                  {formatAge(entry.modifiedAt, now)}
                </span>
              )}
            </button>
          ))}
        </SettingCard>
      )}
    </SettingSection>
  );
}

/** What it did last, newest first; all of it on Activity. */
function ActivitySection(props: { bot: RosterBot }) {
  const { bot } = props;
  const client = useSpadeClient();
  const machine = useSpadeMachine();
  const openBot = useOpenBot(bot);
  const now = useNow();
  const activity = useQuery({
    queryKey: ["spade", "activity", machine.key, bot.id, "latest"],
    queryFn: ({ signal }) => readActivity(client, bot.id, { limit: 3 }, signal),
    refetchInterval: 30_000,
  });
  return (
    <SettingSection
      label="Activity"
      actions={
        <Button size="xs" variant="ghost" onClick={() => openBot({ view: "activity" })}>
          All
        </Button>
      }
    >
      {activity.isPending ? (
        <ListSkeleton label="activity" shape="row" rows={2} />
      ) : activity.isError ? (
        <SettingRow title="Couldn't read the activity" description={message(activity.error)} />
      ) : activity.data.entries.length === 0 ? (
        <SettingRow title="Nothing yet" />
      ) : (
        activity.data.entries.map((entry) => (
          <SettingRow
            key={entry.id}
            inline
            title={spadeActivityWords(entry).sentence}
            description={spadeActivityWords(entry).detail}
          >
            <span className="text-meta text-muted-foreground tabular-nums">
              {formatAge(entry.at, now)}
            </span>
          </SettingRow>
        ))
      )}
    </SettingSection>
  );
}

/** This month's spend and today's, its caps, and its model review; Edit changes them. */
function SpendingSection(props: { bot: RosterBot; onEdit(): void }) {
  const spending = props.bot.spending;
  const review = props.bot.review;
  return (
    <SettingSection
      label="Spending"
      actions={
        <Button size="xs" variant="ghost" onClick={props.onEdit}>
          Edit
        </Button>
      }
    >
      <SettingRow
        inline
        title="This month"
        description={spending ? `${spadeMoney(spending.todayMicros)} today` : undefined}
      >
        <span className="text-ui tabular-nums">
          {spending ? spadeMoney(spending.monthMicros) : "Not recorded"}
        </span>
      </SettingRow>
      <SettingRow inline title="Daily cap">
        <span className="text-ui tabular-nums">
          {spending?.dailyCapMicros === undefined ? "None" : spadeMoney(spending.dailyCapMicros)}
        </span>
      </SettingRow>
      {spending?.monthlyCapMicros !== undefined && (
        <SettingRow inline title="Monthly cap">
          <span className="text-ui tabular-nums">{spadeMoney(spending.monthlyCapMicros)}</span>
        </SettingRow>
      )}
      <SettingRow inline title="Review">
        <span className="text-ui text-muted-foreground">
          {review === undefined ? "Follows default" : review ? "On" : "Off"}
        </span>
      </SettingRow>
    </SettingSection>
  );
}
