import { spadeStateLine } from "@ace/ui-core/spade-chat";
import { Link, Navigate, useNavigate } from "@tanstack/react-router";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { Button } from "@/components/ui/button.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Screen } from "@/features/shell/index.ts";
import { readingColumn } from "@/features/thread/index.ts";
import { useMachines } from "@/lib/machines.ts";
import { EditBotDialog } from "./spade-bot-dialog.tsx";
import { SpadeChat, type ChatBot } from "./spade-chat.tsx";
import { SpadeComposer } from "./spade-composer.tsx";
import { SpadeFace } from "./spade-face.tsx";
import { SpadeKeySetup } from "./spade-key-setup.tsx";
import { SpadeMachineScope, spadeMachineKey } from "./spade-machine.tsx";
import { SpadeRoutines } from "./spade-routines.tsx";
import { SpadeStateStrip } from "./spade-state.tsx";
import { useDeleteBot } from "./use-bot-actions.ts";
import { useSpadeConversation } from "./use-spade-conversation.ts";
import { useSpadeEnabled } from "./use-spade-enabled.ts";
import { useSpadeRoster, type RosterBot } from "./use-spade-roster.ts";
import { useSpadeStatus } from "./use-spade-status.ts";

/** Spade's state line on this window's machine. */
function useSpadeLine() {
  const [enabled] = useSpadeEnabled();
  return spadeStateLine(useSpadeStatus(), enabled);
}

function pinToEnd(element: HTMLElement | null, atEnd: boolean) {
  if (element && atEnd) element.scrollTop = element.scrollHeight;
}

/**
 * A scroller that stays at its end while the person is there, as the conversation grows: on
 * every render and whenever the content's height changes after it.
 */
function Scroller(props: { children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => pinToEnd(scroller.current, atEnd.current));
  useLayoutEffect(() => {
    const inner = content.current;
    if (!inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => pinToEnd(scroller.current, atEnd.current));
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const element = event.currentTarget;
        atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      }}
      className="col-start-1 row-start-1 flex min-h-0 flex-col overflow-y-auto [scrollbar-gutter:stable_both-edges]"
    >
      {/* Room under the last line for the composer floating over the conversation. */}
      <div
        ref={content}
        className={`${readingColumn} mt-auto w-full pt-6 pb-[calc(var(--composer-clearance,0px)+1rem)]`}
      >
        {props.children}
      </div>
    </div>
  );
}

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
 * `view=routines` its routines and heartbeat.
 */
export function SpadeAgentScreen(props: {
  agentId: string;
  machine: string | undefined;
  view?: "routines" | undefined;
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
      {props.view === "routines" ? (
        <BotScreen bot={bot} view="routines">
          <SpadeRoutines key={`${bot.machine.key}/${bot.id}`} bot={bot} />
        </BotScreen>
      ) : (
        <Conversation key={`${bot.machine.key}/${bot.id}`} bot={bot} roster={roster.bots} />
      )}
    </SpadeMachineScope>
  );
}

/**
 * The screen's frame for one bot: its face and name in the top bar; Routines (or back to the
 * conversation), Edit and Delete in ⋯.
 */
function BotScreen(props: { bot: RosterBot; view?: "routines" | undefined; children: ReactNode }) {
  const { bot } = props;
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>();
  const remove = useDeleteBot();
  const navigate = useNavigate();
  const main = bot.kind === "main";
  return (
    <Screen
      title={bot.name}
      mark={<SpadeFace avatar={bot.avatar} size={20} />}
      menu={
        bot.away || bot.unavailable ? undefined : (
          <>
            <MenuItem
              onClick={() =>
                void navigate({
                  to: "/spade/$agentId",
                  params: { agentId: bot.id },
                  search: {
                    ...(bot.machine.primary ? {} : { on: bot.machine.key }),
                    ...(props.view === "routines" ? {} : { view: "routines" as const }),
                  },
                })
              }
            >
              {props.view === "routines" ? "Conversation" : "Routines"}
            </MenuItem>
            <MenuItem onClick={() => setEditing(true)}>{main ? "Edit Spade" : "Edit bot"}</MenuItem>
            {!main && (
              <MenuItem
                danger
                onClick={() =>
                  setConfirming({
                    title: `Delete ${bot.name}?`,
                    body: `This deletes ${bot.name} and its whole conversation.`,
                    confirm: "Delete bot",
                    run: () =>
                      void remove(bot).then((done) => {
                        if (done) void navigate({ to: "/spade", replace: true });
                      }),
                  })
                }
              >
                Delete bot
              </MenuItem>
            )}
          </>
        )
      }
    >
      {props.children}
      {editing && <EditBotDialog bot={bot} onClose={() => setEditing(false)} />}
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </Screen>
  );
}

function Conversation(props: { bot: RosterBot; roster: readonly RosterBot[] }) {
  const { bot } = props;
  const conversation = useSpadeConversation(bot.conversation);
  const { view, problem } = conversation;
  const line = spadeStateLine(useSpadeStatus(), true);
  const toast = useToast();
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
              onAnswer={(callId, allowed) =>
                conversation.answer(callId, allowed, false).then(
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
    </BotScreen>
  );
}

function ConversationSkeleton() {
  return (
    <LoadingRegion label="Conversation" className="flex flex-col gap-3">
      <Skeleton className="ml-auto h-9 w-48 rounded-lg" />
      <Skeleton className="h-14 w-3/4 rounded-lg" />
    </LoadingRegion>
  );
}

function Problem(props: { text: string; onRetry(): void }) {
  return (
    <div role="alert" className="flex items-center gap-2 text-ui text-muted-foreground">
      <span className="min-w-0 flex-1">{props.text}</span>
      <Button size="xs" variant="ghost" onClick={props.onRetry}>
        Try again
      </Button>
    </div>
  );
}

const message = (error: unknown) => (error instanceof Error ? error.message : "Try again.");
