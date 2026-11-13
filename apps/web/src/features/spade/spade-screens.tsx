import type { SpadeSurfaceKind } from "@ace/ui-core/spade-chat";
import { Link, Navigate } from "@tanstack/react-router";
import { Screen, ViewListPage } from "@/features/shell/index.ts";
import { readingColumn } from "@/features/thread/index.ts";
import { useMachines } from "@/lib/machines.ts";
import { SpadeActivity } from "./spade-activity.tsx";
import { BotScreen, type BotView } from "./spade-bot-screen.tsx";
import { BotPage } from "./spade-bot-page.tsx";
import { Conversation } from "./spade-conversation.tsx";
import { SpadeMachineScope, spadeMachineKey } from "./spade-machine.tsx";
import { SpadeRoutines } from "./spade-routines.tsx";
import { SpadeStateStrip } from "./spade-state.tsx";
import { useSpadeRoster } from "./use-spade-roster.ts";
import { ConversationSkeleton, Problem, useSpadeLine } from "./spade-screen-parts.tsx";

/**
 * `/spade`: on a phone, the list itself, as its own screen; wider, Spade's own conversation,
 * once the roster says where Spade is.
 */
export function SpadeHomeScreen() {
  return <ViewListPage title="Spade" fallback={<SpadeHome />} />;
}

function SpadeHome() {
  const line = useSpadeLine();
  const roster = useSpadeRoster(line.ready);
  const main = roster.bots.find((bot) => bot.kind === "main");
  if (main)
    return (
      <Navigate
        to="/spade/$agentId"
        params={{ agentId: main.id }}
        search={main.machine.primary ? {} : { on: main.machine.key }}
        replace
      />
    );
  return (
    <Screen title="Spade" namedByPanel>
      <div className={`${readingColumn} pt-6`}>
        {line.ready ? (
          roster.error ? (
            <Problem text="Couldn't read Spade's bots." onRetry={roster.refetch} />
          ) : (
            <ConversationSkeleton />
          )
        ) : (
          <SpadeStateStrip line={line} className="flex items-center gap-2 px-1 text-ui" />
        )}
      </div>
    </Screen>
  );
}

/**
 * `/spade/<agent id>` (with `on` when the bot runs on another machine): its conversation; with
 * `computer` its computer expanded on that surface (`files` and `file` for the file manager);
 * with `view` its own page, or its routines or activity alone.
 */
export function SpadeAgentScreen(props: {
  agentId: string;
  machine: string | undefined;
  computer?: SpadeSurfaceKind | undefined;
  files?: string | undefined;
  /** With `files`, a file in it opened. */
  file?: string | undefined;
  view?: BotView | undefined;
}) {
  const line = useSpadeLine();
  const roster = useSpadeRoster(line.ready);
  const machines = useMachines();
  const machine = machines.find(
    (candidate) => spadeMachineKey(candidate) === (props.machine ?? "primary"),
  );
  const bot = roster.bots.find(
    (candidate) =>
      candidate.id === props.agentId && candidate.machine.key === (props.machine ?? "primary"),
  );
  if (!bot || !machine)
    return (
      <Screen title="Spade" namedByPanel>
        <div className={`${readingColumn} pt-6`}>
          {!line.ready ? (
            <SpadeStateStrip line={line} className="flex items-center gap-2 px-1 text-ui" />
          ) : roster.loading ? (
            <ConversationSkeleton />
          ) : (
            <p className="text-ui text-muted-foreground">
              This bot isn't here any more.{" "}
              <Link to="/spade" className="text-foreground underline underline-offset-3">
                Open Spade
              </Link>
            </p>
          )}
        </div>
      </Screen>
    );
  if (bot.unavailable)
    return (
      <BotScreen bot={bot}>
        <div className={`${readingColumn} pt-6 text-ui text-muted-foreground`}>
          {/* This machine's Spade says why, with Turn on while it is off. */}
          {bot.machine.primary ? (
            <SpadeStateStrip line={line} className="flex items-center gap-2 px-1 text-ui" />
          ) : (
            `Spade isn't running on ${machine.name}. ${bot.name} is back when it is.`
          )}
        </div>
      </BotScreen>
    );
  const key = `${bot.machine.key}/${bot.id}`;
  // An older link to the files opens the computer on Files.
  const computer = props.computer ?? (props.files !== undefined ? "files" : undefined);
  const folder = props.files === undefined || props.files === "." ? "" : props.files;
  return (
    <SpadeMachineScope
      machine={machine}
      unavailable={
        <BotScreen bot={bot}>
          <div className={`${readingColumn} pt-6 text-ui text-muted-foreground`}>
            {`${machine.name} is offline. ${bot.name} is back when it is.`}
          </div>
        </BotScreen>
      }
    >
      {props.view === "bot" ? (
        <BotPage key={key} bot={bot} />
      ) : props.view === "routines" ? (
        <BotScreen bot={bot}>
          <SpadeRoutines key={key} bot={bot} />
        </BotScreen>
      ) : props.view === "activity" ? (
        <BotScreen bot={bot}>
          <SpadeActivity key={key} bot={bot} />
        </BotScreen>
      ) : (
        <Conversation
          key={key}
          bot={bot}
          roster={roster.bots}
          computer={computer}
          files={{ folder, file: props.file }}
        />
      )}
    </SpadeMachineScope>
  );
}
