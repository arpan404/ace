import { spadeLiveSurfaces, spadeStateLine, type SpadeSurfaceKind } from "@ace/ui-core/spade-chat";
import { ChatCircleIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ResizeHandle } from "@/components/ui/resize-handle.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { usePhone } from "@/lib/breakpoints.ts";
import { BotScreen, useOpenBot } from "./spade-bot-screen.tsx";
import { SpadeChat, type ChatBot } from "./spade-chat.tsx";
import { SpadeComposer } from "./spade-composer.tsx";
import { SpadeKeySetup } from "./spade-key-setup.tsx";
import { SpadeRequestStrip } from "./spade-request-strip.tsx";
import { SpadeStateStrip } from "./spade-state.tsx";
import { ComputerTile } from "./computer/computer-tile.tsx";
import { ComputerView, type FilesAt } from "./computer/computer-view.tsx";
import { useBotComputer } from "./computer/use-bot-computer.ts";
import { ConversationSkeleton, message, Problem, Scroller } from "./spade-screen-parts.tsx";
import { useSpadeConversation } from "./use-spade-conversation.ts";
import { useSpadeModels } from "./use-spade-models.ts";
import type { RosterBot } from "./use-spade-roster.ts";
import { useSkillProposals } from "./use-skill-proposals.ts";
import { useSpadeStatus } from "./use-spade-status.ts";

const dock = { initial: 380, min: 300, max: 560 };

/**
 * A bot's conversation. While it uses its computer, a live tile is pinned above the chat; Expand
 * gives the computer the main column with the chat docked at its right (resizable, and hidden or
 * shown again by Chat in the top bar). On a phone the computer is the whole screen, with ‹ Chat.
 * `computer` (the route's) is the surface shown expanded; `files` where its file manager is.
 */
export function Conversation(props: {
  bot: RosterBot;
  roster: readonly RosterBot[];
  computer: SpadeSurfaceKind | undefined;
  files: FilesAt;
}) {
  const { bot } = props;
  const conversation = useSpadeConversation(bot.conversation);
  const { view, problem } = conversation;
  const line = spadeStateLine(useSpadeStatus(), true);
  const toast = useToast();
  const skills = useSkillProposals(bot.id, view);
  const openBot = useOpenBot(bot);
  const phone = usePhone();
  const computer = useBotComputer(bot, conversation.side);
  const endpoints = useSpadeModels(true).data?.endpoints;
  const endpointName = (id: string) => endpoints?.find((endpoint) => endpoint.id === id)?.name;
  const [stopping, setStopping] = useState(false);
  // The tile the person hid stays hidden until the bot starts on something else.
  const [hidden, setHidden] = useState<string>();
  const [chatShown, setChatShown] = useState(true);
  const [dockWidth, setDockWidth] = useState(dock.initial);
  // Stopping lasts until nothing is open: the reply and its background jobs.
  if (stopping && !view.busy) setStopping(false);
  const stop = () => {
    setStopping(true);
    conversation.stop().catch((error: unknown) => {
      setStopping(false);
      toast.error({ title: `Couldn't stop ${bot.name}`, description: message(error) });
    });
  };
  const failed = (title: string) => (error: unknown) => {
    toast.error({ title, description: message(error) });
    return false;
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
  const live = spadeLiveSurfaces(computer.computer);
  const tiled = live[0];
  const tileKey = tiled ? `${tiled.kind}:${tiled.since ?? ""}` : undefined;
  const expanded = props.computer !== undefined;
  const expand = (kind: SpadeSurfaceKind) => openBot({ computer: kind });
  const showTile = tiled !== undefined && hidden !== tileKey && !expanded;
  const request = view.approvals[0];

  const chat = (openMemory: Parameters<typeof SpadeChat>[0]["onRemembered"]) => (
    <div data-thread-column="" className="grid h-full min-h-0 grid-cols-1 grid-rows-1">
      <Scroller
        pinned={
          showTile && (
            <ComputerTile
              machine={bot.machine}
              bot={bot.id}
              surface={tiled}
              driving={computer.driving || computer.stopping}
              pending={computer.pending !== undefined}
              compact={phone}
              onExpand={() => expand(tiled.kind)}
              onTakeOver={computer.takeOver}
              onHide={() => setHidden(tileKey)}
            />
          )
        }
      >
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
            onWatch={tiled && hidden === tileKey ? () => setHidden(undefined) : undefined}
            onRemembered={openMemory}
            onOpenFile={(path) =>
              openBot({
                computer: "files",
                files: path.split("/").slice(0, -1).join("/"),
                file: path,
              })
            }
            endpointName={endpointName}
            onRetry={(text) =>
              conversation
                .send({ text, images: [] })
                .then(() => true, failed(`Couldn't send to ${bot.name}`))
            }
            proposals={skills.proposals}
            onProposal={(id, save) =>
              skills
                .answer(id, save)
                .then(
                  () => true,
                  failed(save ? "Couldn't save the skill" : "Couldn't discard the skill"),
                )
            }
          />
        )}
      </Scroller>
      <SpadeComposer
        name={bot.name}
        draftKey={`spade:${bot.machine.key}:${bot.id}`}
        answering={view.busy}
        onStop={stop}
        stopping={stopping}
        blocked={line.ready ? undefined : line.sentence}
        placeholder={`Message ${bot.name}`}
        attached={
          request && (
            <SpadeRequestStrip
              bot={chatBot}
              approval={request}
              more={view.approvals.length - 1}
              onAnswer={(callId, allowed, always) =>
                conversation
                  .answer(callId, allowed, always)
                  .then(() => true, failed(`Couldn't answer ${bot.name}`))
              }
            />
          )
        }
        send={conversation.send}
      />
    </div>
  );

  if (!props.computer)
    return (
      <BotScreen bot={bot}>
        {(openMemory) => chat((note) => openMemory({ shared: note.shared, note: note.id }))}
      </BotScreen>
    );
  const shown = props.computer;
  const computerView = (
    <ComputerView
      bot={bot}
      machine={bot.machine}
      state={computer}
      open={shown}
      onOpen={(kind) => openBot({ computer: kind })}
      files={props.files}
      onFiles={(to) =>
        openBot({ computer: "files", files: to.folder, ...(to.file ? { file: to.file } : {}) })
      }
      side={conversation.side}
      phone={phone}
      onCollapse={() => openBot()}
    />
  );
  if (phone) return <BotScreen bot={bot}>{computerView}</BotScreen>;
  return (
    <BotScreen
      bot={bot}
      actions={
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={chatShown}
          onClick={() => setChatShown((on) => !on)}
          className="gap-1.5"
        >
          <Icon icon={ChatCircleIcon} size={16} />
          Chat
        </Button>
      }
    >
      {(openMemory) => (
        <div className="flex h-full min-h-0">
          <div className="min-w-0 flex-1">{computerView}</div>
          {chatShown && (
            <aside
              aria-label={`Chat with ${bot.name}`}
              style={{ width: dockWidth }}
              className="relative shrink-0 border-l border-border [--column:100%]"
            >
              <ResizeHandle
                label="Chat width"
                edge="left"
                size={dockWidth}
                min={dock.min}
                max={dock.max}
                onResize={setDockWidth}
                onReset={() => setDockWidth(dock.initial)}
              />
              {chat((note) => openMemory({ shared: note.shared, note: note.id }))}
            </aside>
          )}
        </div>
      )}
    </BotScreen>
  );
}
