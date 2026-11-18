import {
  spadeForLaterWords,
  spadeLiveSurfaces,
  spadeStateLine,
  spadeTaskLine,
} from "@ace/ui-core/spade-chat";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { SidebarSimpleIcon } from "@ace/icons";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
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
import type { FilesAt } from "./computer/profile-computer.tsx";
import {
  panelWidth,
  readPanel,
  writePanel,
  type ComputerView,
  type ProfileTab,
} from "./computer/panel-place.ts";
import { ProfileStripActions, SpadeProfile } from "./spade-profile.tsx";
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
import { useSpadeClient } from "./spade-machine.tsx";
import { actOnWake, useSpadeDigests } from "./spade-wakes-api.ts";

/** Below 680px the profile takes the window (docs/design/spade.md §1). */
const coverQuery = "(max-width: 42.49rem)";
/** The chat column keeps this much beside the profile. */
const chatMin = 360;

/** The oldest card left for later: scrolled to and focused, its inputs ready. */
const showCard = (callId: string | undefined) => {
  const card = callId ? document.querySelector<HTMLElement>(questionAnchor(callId)) : null;
  card?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  card?.focus({ preventScroll: true });
};

const storage = () => (typeof localStorage === "undefined" ? undefined : localStorage);

/**
 * A bot's conversation under its pill, with its profile (Details, Library, Computer) beside it
 * when open: opened by the pill, by the profile toggle in the top bar, by Watch on the working
 * line (on Computer, at what it uses) and by a file chip (on its Files), resizable from its edge.
 * Open or closed, its tab, Computer's view and its width are remembered per bot. Below 680px it
 * takes the window, with ‹ Chat to go back. `profile` (the route's) is the tab it shows,
 * `computer` what Computer shows and `files` where its file manager is.
 */
export function Conversation(props: {
  bot: RosterBot;
  roster: readonly RosterBot[];
  profile: ProfileTab | undefined;
  computer: ComputerView | undefined;
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
  const endpoints = useSpadeModels(true).data?.endpoints;
  const client = useSpadeClient();
  const digests = useSpadeDigests(bot.id);
  const endpointName = (id: string) => endpoints?.find((endpoint) => endpoint.id === id)?.name;
  const [stopping, setStopping] = useState(false);
  // A decision the person is changing: quoted on their next message (Work's Change).
  const [quote, setQuote] = useState<string>();
  const covering = useMediaQuery(coverQuery, false);
  const memoryKey = `${bot.machine.key}/${bot.id}`;
  const [width, setWidth] = useState(() => readPanel(storage(), memoryKey).width);
  const tab = props.profile;
  const go = (to: BotPlace, replace = false) =>
    void navigate({
      to: "/spade/$agentId",
      params: { agentId: bot.id },
      search: botSearch(bot, to),
      replace,
    });
  /** Computer, on what it shows (and where its files are). */
  const openComputer = (shows: ComputerView, files?: FilesAt) =>
    go({
      profile: "computer",
      computer: shows,
      ...(files ? { files: files.folder, ...(files.file ? { file: files.file } : {}) } : {}),
    });
  const closePanel = () => {
    writePanel(storage(), memoryKey, { ...readPanel(storage(), memoryKey), open: false });
    go({});
  };
  // The profile as the person left it for this bot: opened again on arrival, without a new
  // history entry; whatever the route says after that is remembered.
  const arrived = useRef(false);
  useEffect(() => {
    const remembered = readPanel(storage(), memoryKey);
    if (!arrived.current) {
      arrived.current = true;
      if (tab === undefined && remembered.open) {
        go(
          {
            profile: remembered.tab,
            ...(remembered.tab === "computer" && remembered.view
              ? { computer: remembered.view }
              : {}),
          },
          true,
        );
        return;
      }
    }
    if (tab !== undefined)
      writePanel(storage(), memoryKey, {
        ...remembered,
        open: true,
        tab,
        view: props.computer ?? remembered.view,
      });
    // `go` is a new function each render; the route's tab and view are what this follows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, props.computer, memoryKey]);
  // A task it carries on by itself: its line stays between replies, and Stop with it.
  const task = spadeTaskLine(bot.name, bot.progress, view.status ?? bot.status);
  const open = spadeWorks(view, task, bot.progress?.continuing === true);
  // It drives its computer only while it is at work.
  const computer = useBotComputer(bot, conversation.side, open);
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
  const panelShown = tab !== undefined;

  const chat = (
    <div data-thread-column="" className="relative grid h-full min-h-0 grid-cols-1 grid-rows-1">
      <h1 className="sr-only">{bot.name}</h1>
      <ConversationPill bot={bot} onOpen={() => openProfile()} />
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
            // While it uses its computer and Computer isn't showing, Watch opens it there.
            onWatch={
              using && !(panelShown && tab === "computer")
                ? () => openComputer(using.kind)
                : undefined
            }
            paused={computer.paused}
            task={task}
            onAnswer={(callId, answer) =>
              conversation
                .answer(callId, answer !== "deny", answer === "always")
                .then(() => true, failed(`Couldn't answer ${bot.name}`))
            }
            onAnswerOutside={(id, answer) =>
              conversation
                .answerOutside(id, answer !== "deny", answer === "always")
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
              openComputer("files", { folder: path.split("/").slice(0, -1).join("/"), file: path })
            }
            endpointName={endpointName}
            digests={digests}
            onWake={(wake, action) =>
              actOnWake(client, bot.id, wake, action).then(
                () => true,
                failed(
                  action === "cancel"
                    ? `Couldn't cancel ${bot.name}'s wait`
                    : `Couldn't wake ${bot.name}`,
                ),
              )
            }
            onOpenBot={(id) => {
              // A worker runs on its maker's machine.
              const worker = props.roster.find(
                (other) => other.id === id && other.machine.key === bot.machine.key,
              );
              if (worker)
                void navigate({
                  to: "/spade/$agentId",
                  params: { agentId: worker.id },
                  search: botSearch(worker),
                });
            }}
            onOpenWork={() => go({ profile: "work" })}
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
        quote={
          quote === undefined ? undefined : { text: quote, onRemove: () => setQuote(undefined) }
        }
        send={conversation.send}
      />
    </div>
  );

  const panel = tab && (
    <SpadeProfile
      bot={bot}
      tab={tab}
      onTab={(next) => go({ profile: next })}
      computer={{
        view: props.computer,
        files: props.files,
        onView: openComputer,
        state: computer,
        side: conversation.side,
      }}
      work={{
        decisions: view.decisions,
        entries: view.entries,
        roster: props.roster,
        onChange: (decision) => {
          setQuote(decision.choice);
          // Where the profile takes the window, the chat comes back to write in.
          if (covering) closePanel();
        },
        onOpenFile: (path) =>
          openComputer("files", { folder: path.split("/").slice(0, -1).join("/"), file: path }),
        onOpenActivity: () => openComputer("activity"),
      }}
      covering={covering}
      onClose={closePanel}
    />
  );

  return (
    <ConversationScreen
      actions={
        // Covered by the profile, the chat comes back by the profile's own ‹ Chat.
        !(panelShown && covering) && (
          <>
            {view.questionsForLater > 0 && (
              <Button size="sm" variant="ghost" onClick={() => showCard(view.forLater[0])}>
                {spadeForLaterWords(view.questionsForLater)}
              </Button>
            )}
            {panelShown ? (
              // The top bar's part above the profile holds its strip: Share and close.
              <ProfileStripActions bot={bot} onClose={closePanel} />
            ) : (
              <IconButton
                icon={SidebarSimpleIcon}
                label={`Open ${bot.name}'s profile`}
                tip="Profile"
                className="-scale-x-100"
                onClick={() => openProfile()}
              />
            )}
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
          <div
            // Beside the chat the chat keeps a readable column; in a narrow window the profile
            // takes the window.
            style={covering ? undefined : { width, maxWidth: `calc(100% - ${chatMin}px)` }}
            className={cn(
              "bg-panel",
              covering ? "absolute inset-0 z-20" : "relative shrink-0 border-l border-border",
            )}
          >
            {!covering && (
              <ResizeHandle
                label="Profile width"
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
          </div>
        )}
      </div>
    </ConversationScreen>
  );
}
