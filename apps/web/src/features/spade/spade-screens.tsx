import { spadeStateLine } from "@ace/ui-core/spade-chat";
import { Link, Navigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { Screen } from "@/features/shell/index.ts";
import { readingColumn } from "@/features/thread/index.ts";
import { useMachines } from "@/lib/machines.ts";
import { SpadeActivity } from "./spade-activity.tsx";
import { BotScreen, useOpenBot, type BotView } from "./spade-bot-screen.tsx";
import { SpadeChat, type ChatBot } from "./spade-chat.tsx";
import { SpadeComposer } from "./spade-composer.tsx";
import { SpadeFiles } from "./spade-files.tsx";
import { SpadeKeySetup } from "./spade-key-setup.tsx";
import { SpadeMachineScope, spadeMachineKey } from "./spade-machine.tsx";
import { SpadeRoutines } from "./spade-routines.tsx";
import { SpadeStateStrip } from "./spade-state.tsx";
import { useSpadeConversation } from "./use-spade-conversation.ts";
import { useSpadeRoster, type RosterBot } from "./use-spade-roster.ts";
import { useSkillProposals } from "./use-skill-proposals.ts";
import {
  ConversationSkeleton,
  message,
  Problem,
  Scroller,
  useSpadeLine,
} from "./spade-screen-parts.tsx";
import { useSpadeStatus } from "./use-spade-status.ts";

/** `/spade`: Spade's own conversation, once the roster says where Spade is. */
export function SpadeHomeScreen() {
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
 * `/spade/<agent id>` (with `on` when the bot runs on another machine): its conversation, or with
 * `files` its files (and `file` open), or with `view` its routines or its activity.
 */
export function SpadeAgentScreen(props: {
  agentId: string;
  machine: string | undefined;
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
      {props.files !== undefined ? (
        <BotScreen bot={bot} files>
          <FilesOf bot={bot} folder={props.files === "." ? "" : props.files} file={props.file} />
        </BotScreen>
      ) : props.view === "routines" ? (
        <BotScreen bot={bot} view="routines">
          <SpadeRoutines key={`${bot.machine.key}/${bot.id}`} bot={bot} />
        </BotScreen>
      ) : props.view === "activity" ? (
        <BotScreen bot={bot} view="activity">
          <SpadeActivity key={`${bot.machine.key}/${bot.id}`} bot={bot} />
        </BotScreen>
      ) : (
        <Conversation key={`${bot.machine.key}/${bot.id}`} bot={bot} roster={roster.bots} />
      )}
    </SpadeMachineScope>
  );
}

function FilesOf(props: { bot: RosterBot; folder: string; file: string | undefined }) {
  const openBot = useOpenBot(props.bot);
  return (
    <div className="h-full min-h-0 overflow-y-auto [scrollbar-gutter:stable_both-edges]">
      {/* A new bot, machine or folder starts fresh: no file left open, no question left asked. */}
      <SpadeFiles
        key={`${props.bot.machine.key}/${props.bot.id}/${props.folder}/${props.file ?? ""}`}
        bot={props.bot}
        folder={props.folder}
        file={props.file}
        onFolder={(files) => openBot({ files })}
      />
    </div>
  );
}

function Conversation(props: { bot: RosterBot; roster: readonly RosterBot[] }) {
  const { bot } = props;
  const conversation = useSpadeConversation(bot.conversation);
  const { view, problem } = conversation;
  const line = spadeStateLine(useSpadeStatus(), true);
  const toast = useToast();
  const skills = useSkillProposals(bot.id, view);
  const openBot = useOpenBot(bot);
  const [stopping, setStopping] = useState(false);
  // Stopping lasts until nothing is open: the reply and its background jobs.
  if (stopping && !view.busy) setStopping(false);
  const stop = () => {
    setStopping(true);
    conversation.stop().catch((error: unknown) => {
      setStopping(false);
      toast.error({ title: `Couldn't stop ${bot.name}`, description: message(error) });
    });
  };
  const chatBot = useMemo<ChatBot>(
    () => ({
      name: bot.name,
      avatar: bot.avatar,
      others: new Map(
        props.roster
          .filter((other) => other.machine.key === bot.machine.key)
          .map((other) => [other.id, other.avatar]),
      ),
    }),
    [bot, props.roster],
  );
  return (
    <BotScreen bot={bot}>
      {(openMemory) => (
        <div data-thread-column="" className="grid h-full min-h-0 grid-cols-1 grid-rows-1">
          <Scroller>
            {bot.kind === "main" && <SpadeKeySetup main={bot} />}
            {problem ? (
              <Problem text={problem} onRetry={conversation.retry} />
            ) : !view.loaded ? (
              line.ready ? (
                <ConversationSkeleton />
              ) : (
                <SpadeStateStrip line={line} className="flex items-center gap-2 text-ui" />
              )
            ) : (
              <SpadeChat
                bot={chatBot}
                view={view}
                stopping={stopping}
                onStop={stop}
                onRemembered={(note) => openMemory({ shared: note.shared, note: note.id })}
                onOpenFile={(path) =>
                  openBot({ files: path.split("/").slice(0, -1).join("/"), file: path })
                }
                proposals={skills.proposals}
                onProposal={(id, save) =>
                  skills.answer(id, save).then(
                    () => true,
                    (error: unknown) => {
                      toast.error({
                        title: save ? "Couldn't save the skill" : "Couldn't discard the skill",
                        description: message(error),
                      });
                      return false;
                    },
                  )
                }
                onAnswer={(callId, allowed, always) =>
                  conversation.answer(callId, allowed, always).then(
                    () => true,
                    (error: unknown) => {
                      toast.error({
                        title: `Couldn't answer ${bot.name}`,
                        description: message(error),
                      });
                      return false;
                    },
                  )
                }
              />
            )}
          </Scroller>
          <SpadeComposer
            name={bot.name}
            draftKey={`spade:${bot.machine.key}:${bot.id}`}
            answering={view.answering}
            blocked={line.ready ? undefined : line.sentence}
            placeholder={`Message ${bot.name}`}
            send={conversation.send}
          />
        </div>
      )}
    </BotScreen>
  );
}
