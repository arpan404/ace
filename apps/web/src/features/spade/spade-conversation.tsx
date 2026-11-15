import {
  spadeForLaterWords,
  spadeBubbles,
  spadeLiveSurfaces,
  spadeStateLine,
  spadeTaskLine,
  type SpadeChatItem,
} from "@ace/ui-core/spade-chat";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { ResizeHandle } from "@/components/ui/resize-handle.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import { useMediaQuery } from "@/lib/media.ts";
import {
  ConversationScreen,
  botSearch,
  useOpenProfile,
  type BotPlace,
} from "./spade-bot-screen.tsx";
import { SpadeChat, type ChatBot } from "./spade-chat.tsx";
import { SpadeComposer } from "./spade-composer.tsx";
import { SpadeKeySetup } from "./spade-key-setup.tsx";
import { ConversationPill } from "./spade-pill.tsx";
import { SpadeStateStrip } from "./spade-state.tsx";
import { ComputerPanel, type FilesAt } from "./computer/computer-view.tsx";
import { panelWidth, readPanel, writePanel, type PanelSection } from "./computer/panel-place.ts";
import { useBotComputer } from "./computer/use-bot-computer.ts";
import { ConversationSkeleton, message, Problem, Scroller } from "./spade-screen-parts.tsx";
import { questionAnchor } from "./spade-question-bubble.tsx";
import { SpadeRequestError } from "./spade-requests.ts";
import { useSpadeConversation } from "./use-spade-conversation.ts";
import { useSpadeModels } from "./use-spade-models.ts";
import type { RosterBot } from "./use-spade-roster.ts";
import { useSkillProposals } from "./use-skill-proposals.ts";
import { useSpadeStatus } from "./use-spade-status.ts";
import { spadeWorks } from "./spade-works.ts";

/** A window too narrow for the panel beside a readable chat: the panel covers the chat. */
const coverQuery = "(max-width: 59.99rem)";
/** The chat column keeps this much beside the panel. */
const chatMin = 400;

/** The oldest card left for later: scrolled to and focused, its inputs ready. */
const showCard = (callId: string | undefined) => {
  const card = callId ? document.querySelector<HTMLElement>(questionAnchor(callId)) : null;
  card?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  card?.focus({ preventScroll: true });
};

const storage = () => (typeof localStorage === "undefined" ? undefined : localStorage);

/**
 * A bot's conversation under its pill, which names the bot and opens its profile, with its right panel (the computer's Browser, Screen, Terminal and Files,
 * its Activity and its Helpers) beside it when open: opened by Computer in the top bar ("Computer
 * · in use" while the bot uses it), by Watch on the working line and by a file chip, resizable
 * from its edge. Open or closed, its section and its width are remembered per bot. In a narrow
 * window the panel covers the chat at full height, with Chat to go back. `computer` (the
 * route's) is the section the panel shows; `files` where its file manager is.
 */
export function Conversation(props: {
  bot: RosterBot;
  roster: readonly RosterBot[];
  computer: PanelSection | undefined;
  files: FilesAt;
}) {
  const { bot } = props;
  const conversation = useSpadeConversation(bot.conversation);
  const { view, problem } = conversation;
  const line = spadeStateLine(useSpadeStatus(), true);
  const toast = useToast();
  const skills = useSkillProposals(bot.id, view);
  const navigate = useNavigate();
  const openProfile = useOpenProfile(bot);
  const computer = useBotComputer(bot, conversation.side);
  const endpoints = useSpadeModels(true).data?.endpoints;
  const endpointName = (id: string) => endpoints?.find((endpoint) => endpoint.id === id)?.name;
  const [stopping, setStopping] = useState(false);
  const covering = useMediaQuery(coverQuery, false);
  const memoryKey = `${bot.machine.key}/${bot.id}`;
  const [width, setWidth] = useState(() => readPanel(storage(), memoryKey).width);
  const section = props.computer;
  const go = (to: BotPlace, replace = false) =>
    void navigate({
      to: "/spade/$agentId",
      params: { agentId: bot.id },
      search: botSearch(bot, to),
      replace,
    });
  const openPanel = (to: PanelSection, place: Omit<BotPlace, "computer"> = {}) =>
    go({ computer: to, ...place });
  const closePanel = () => {
    writePanel(storage(), memoryKey, { ...readPanel(storage(), memoryKey), open: false });
    go({});
  };
  // The panel as the person left it for this bot: opened again on arrival, without a new
  // history entry; whatever the route says after that is remembered.
  const arrived = useRef(false);
  useEffect(() => {
    const remembered = readPanel(storage(), memoryKey);
    if (!arrived.current) {
      arrived.current = true;
      if (section === undefined && remembered.open) {
        go({ computer: remembered.section }, true);
        return;
      }
    }
    if (section !== undefined)
      writePanel(storage(), memoryKey, { ...remembered, open: true, section });
    // `go` is a new function each render; the route's section is what this follows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, memoryKey]);
  // A task it carries on by itself: its line stays between replies, and Stop with it.
  const task = spadeTaskLine(bot.name, bot.progress, view.status ?? bot.status);
  const open = spadeWorks(view, task, bot.progress?.continuing === true);
  // Stopping lasts until nothing is open: the reply, its background jobs and the task's next step.
  if (stopping && !open) setStopping(false);
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
      id: bot.id,
      name: bot.name,
      avatar: bot.avatar,
      others: new Map(
        props.roster
          .filter((other) => other.machine.key === bot.machine.key)
          .map((other) => [other.id, other.avatar]),
      ),
      names: new Map(props.roster.map((other) => [other.id, other.name])),
    }),
    [bot, props.roster],
  );
  const live = spadeLiveSurfaces(computer.computer);
  const using = live[0];
  const helpers = useMemo(
    () =>
      spadeBubbles(view).filter(
        (item): item is Extract<SpadeChatItem, { kind: "helper" }> => item.kind === "helper",
      ),
    [view],
  );
  const panelShown = section !== undefined;

  const chat = (
    <div data-thread-column="" className="relative grid h-full min-h-0 grid-cols-1 grid-rows-1">
      <h1 className="sr-only">{bot.name}</h1>
      <ConversationPill bot={bot} onOpen={openProfile} />
      <Scroller
        top="pill"
        seen={
          view.loaded
            ? { conversation: bot.conversation, unseen: bot.unseen, seq: bot.lastMessage?.seq }
            : undefined
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
            // While it uses its computer and the panel is closed, Watch opens it there.
            onWatch={using && !panelShown ? () => openPanel(using.kind) : undefined}
            paused={computer.paused}
            task={task}
            onAnswer={(callId, answer) =>
              conversation
                .answer(callId, answer !== "deny", answer === "always")
                .then(() => true, failed(`Couldn't answer ${bot.name}`))
            }
            onQuestion={(callId, reply) =>
              conversation.question(callId, reply).then(
                () => undefined,
                (error: unknown) => {
                  // Spade's own words for a rule an answer broke, or a card no longer open.
                  if (error instanceof SpadeRequestError && error.status === 400)
                    return error.message;
                  if (error instanceof SpadeRequestError && error.status === 409)
                    return "This question isn't open anymore.";
                  toast.error({
                    title: `Couldn't answer ${bot.name}`,
                    description: message(error),
                  });
                  return "";
                },
              )
            }
            onOpenFile={(path) =>
              openPanel("files", { files: path.split("/").slice(0, -1).join("/"), file: path })
            }
            endpointName={endpointName}
            onHelperSteps={conversation.helperSteps}
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
        answering={open}
        // While the person drives the bot is paused, not working: nothing to stop.
        onStop={computer.paused ? undefined : stop}
        stopping={stopping}
        blocked={line.ready ? undefined : line.sentence}
        placeholder={`Message ${bot.name}`}
        send={conversation.send}
      />
    </div>
  );

  const panel = section && (
    <ComputerPanel
      bot={bot}
      state={computer}
      section={section}
      onSection={(to) => openPanel(to, to === "files" ? { files: props.files.folder } : {})}
      files={props.files}
      onFiles={(to) =>
        openPanel("files", { files: to.folder, ...(to.file ? { file: to.file } : {}) })
      }
      side={conversation.side}
      helpers={helpers}
      onHelperSteps={conversation.helperSteps}
      covering={covering}
      onClose={closePanel}
    />
  );

  return (
    <ConversationScreen
      actions={
        // Covered by the panel, the chat comes back by the panel's own Chat.
        !(panelShown && covering) && (
          <>
            {view.questionsForLater > 0 && (
              <Button size="sm" variant="ghost" onClick={() => showCard(view.forLater[0])}>
                {spadeForLaterWords(view.questionsForLater)}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={panelShown}
              aria-label={using ? "Computer, in use" : "Computer"}
              onClick={() =>
                panelShown
                  ? closePanel()
                  : openPanel(using?.kind ?? readPanel(storage(), memoryKey).section)
              }
            >
              {using ? (
                <>
                  Computer<span className="text-muted-foreground">{" · in use"}</span>
                </>
              ) : (
                "Computer"
              )}
            </Button>
          </>
        )
      }
    >
      <div className="relative flex h-full min-h-0">
        <div
          className={cn("min-w-0 flex-1", panelShown && covering && "invisible")}
          aria-hidden={panelShown && covering ? true : undefined}
        >
          {chat}
        </div>
        {panel && (
          <aside
            aria-label="Panel"
            // Beside the chat the chat keeps a readable column; in a narrow window the panel
            // covers it at full height.
            style={covering ? undefined : { width, maxWidth: `calc(100% - ${chatMin}px)` }}
            className={cn(
              "bg-panel",
              covering ? "absolute inset-0 z-20" : "relative shrink-0 border-l border-border",
            )}
          >
            {!covering && (
              <ResizeHandle
                label="Panel width"
                edge="left"
                size={width}
                min={panelWidth.min}
                max={panelWidth.max}
                onResize={setWidth}
                onResizeEnd={(next) =>
                  writePanel(storage(), memoryKey, {
                    ...readPanel(storage(), memoryKey),
                    width: next,
                  })
                }
                onReset={() => {
                  setWidth(panelWidth.initial);
                  writePanel(storage(), memoryKey, {
                    ...readPanel(storage(), memoryKey),
                    width: panelWidth.initial,
                  });
                }}
              />
            )}
            {panel}
          </aside>
        )}
      </div>
    </ConversationScreen>
  );
}
