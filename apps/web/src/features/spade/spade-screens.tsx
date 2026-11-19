import type { ComputerView, ProfileTab } from "./computer/panel-place.ts";
import { Link, Navigate } from "@tanstack/react-router";
import { Screen, ViewListPage } from "@/features/shell/index.ts";
import { readingColumn } from "@/features/thread/index.ts";
import { useMachines } from "@/lib/machines.ts";
import { BotScreen } from "./spade-bot-screen.tsx";
import { Conversation } from "./spade-conversation.tsx";
import { SpadeMachineScope, spadeMachineKey } from "./spade-machine.tsx";
import { centeredStrip, SpadeStateStrip } from "./spade-state.tsx";
import { useSpadeRoster } from "./use-spade-roster.ts";
import { ConversationSkeleton, Problem, useSpadeLine } from "./spade-screen-parts.tsx";

/**
 * `/spade`: on a phone, the list itself, as its own screen; wider, Spade's own conversation,
 * once the roster says where Spade is.
 */
export function SpadeHomeScreen() {
  return <ViewListPage title="Spade" page="spade" fallback={<SpadeHome />} />;
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
    <Screen page="spade" title="Spade" namedByPanel>
      {line.ready ? (
        <div className={`${readingColumn} pt-6`}>
          {roster.error ? (
            <Problem text="Couldn't read Spade's bots." onRetry={roster.refetch} />
          ) : (
            <ConversationSkeleton />
          )}
        </div>
      ) : (
        <div className="grid h-full min-h-72 place-items-center px-6">
          <SpadeStateStrip line={line} className={centeredStrip} />
        </div>
      )}
    </Screen>
  );
}

/**
 * `/spade/<agent id>` (with `on` when the bot runs on another machine): its conversation; with
 * `profile` its profile beside it on that tab (`computer`, `files` and `file` for what Computer
 * shows).
 */
export function SpadeAgentScreen(props: {
  agentId: string;
  machine: string | undefined;
  profile?: ProfileTab | undefined;
  computer?: ComputerView | undefined;
  files?: string | undefined;
  /** With `files`, a file in it opened. */
  file?: string | undefined;
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
  // A bot that moved to another machine (ADR 0187) is followed there.
  const elsewhere = bot
    ? undefined
    : roster.bots.find((candidate) => candidate.id === props.agentId);
  if (elsewhere)
    return (
      <Navigate
        to="/spade/$agentId"
        params={{ agentId: elsewhere.id }}
        search={{
          ...(elsewhere.machine.primary ? {} : { on: elsewhere.machine.key }),
          ...(props.profile ? { profile: props.profile } : {}),
        }}
        replace
      />
    );
  if (!bot || !machine)
    return (
      <Screen page="spade" title="Spade" namedByPanel>
        <div
          className={
            line.ready ? `${readingColumn} pt-6` : "grid h-full min-h-72 place-items-center px-6"
          }
        >
          {!line.ready ? (
            <SpadeStateStrip line={line} className={centeredStrip} />
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
  // A link to Computer's view or to the files opens the profile on Computer.
  const computer = props.computer ?? (props.files !== undefined ? "files" : undefined);
  const profile = props.profile ?? (computer === undefined ? undefined : "computer");
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
      <Conversation
        key={key}
        bot={bot}
        roster={roster.bots}
        profile={profile}
        computer={computer}
        files={{ folder, file: props.file }}
      />
    </SpadeMachineScope>
  );
}
