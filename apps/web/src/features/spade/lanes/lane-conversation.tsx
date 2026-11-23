import { spadeEndedTasksPage, spadeLanesHaveOlder, spadeSentText } from "@ace/ui-core/spade-chat";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { panelReveal } from "@/components/ui/rules.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import { useMediaQuery } from "@/lib/media.ts";
import { panelWidth } from "../computer/panel-place.ts";
import { ConversationScreen, useOpenBot } from "../spade-bot-screen.tsx";
import { SpadeChat, type ChatBot } from "../spade-chat.tsx";
import { SpadeComposer } from "../spade-composer.tsx";
import { PillEdge, TaskPill } from "../spade-pill.tsx";
import { segment, spadeHttp, SpadeRequestError } from "../spade-requests.ts";
import { ConversationSkeleton, message, Problem, Scroller } from "../spade-screen-parts.tsx";
import { useSpadeClient } from "../spade-machine.tsx";
import { useSpadeConversation } from "../use-spade-conversation.ts";
import type { RosterBot } from "../use-spade-roster.ts";
import { useLanesChanged, useSpadeLanes } from "./lanes-api.ts";
import { LanePanel } from "./lane-panel.tsx";

/** Below 680px the goal and plan take the window, as the profile does. */
const coverQuery = "(max-width: 42.49rem)";

/**
 * One of a bot's tasks, opened (ADR 0217 §7): its own transcript, as any conversation shows,
 * under a pill with its title and the bot named after it, which goes back to the bot. Writing
 * in its composer steers this task alone, and its Stop stops this task alone. Its goal and plan
 * sit beside it with Stop task. Its requests are answered in the bot's main conversation, where
 * Spade asks them, so an answer here reaches the task the same way.
 */
export function LaneConversation(props: {
  bot: RosterBot;
  roster: readonly RosterBot[];
  /** The task's lane id, its conversation's id too. */
  task: string;
}) {
  const { bot, task } = props;
  const client = useSpadeClient();
  const toast = useToast();
  const openBot = useOpenBot(bot);
  const conversation = useSpadeConversation(task);
  const { view, problem } = conversation;
  const moved = view.entries.length;
  // Its row, even when it ended long ago: the list is read further back until it is found.
  const [ended, setEnded] = useState(spadeEndedTasksPage);
  const lanes = useSpadeLanes(bot.conversation, moved, true, ended);
  const changed = useLanesChanged(bot.conversation);
  const lane = lanes.find((each) => each.task === task);
  if (!lane && ended < 500 && spadeLanesHaveOlder(lanes, ended)) setEnded(500);
  const title = view.laneTitles.get(task) ?? lane?.title ?? "A task";
  const covering = useMediaQuery(coverQuery, false);
  const [panelOpen, setPanelOpen] = useState(!covering);
  const [stopping, setStopping] = useState(false);
  const [sent, setSent] = useState(0);
  const answering = view.answering || lane?.state === "working";
  if (stopping && lane && lane.state !== "working" && lane.state !== "needs_you")
    setStopping(false);
  const stop = () => {
    setStopping(true);
    conversation.stop().then(changed, (error: unknown) => {
      setStopping(false);
      toast.error({ title: `Couldn't stop ${title}`, description: message(error) });
    });
  };
  const failed = (what: string) => (error: unknown) => {
    toast.error({ title: what, description: message(error) });
    return false;
  };
  const chatBot = useMemo<ChatBot>(
    () => ({
      id: bot.id,
      name: bot.name,
      avatar: bot.avatar,
      style: bot.style,
      others: new Map(props.roster.map((other) => [other.id, other.avatar])),
      names: new Map(props.roster.map((other) => [other.id, other.name])),
    }),
    [bot, props.roster],
  );
  const openFile = (path: string) =>
    openBot({
      profile: "computer",
      computer: "files",
      files: path.split("/").slice(0, -1).join("/"),
      file: path,
    });

  const chat = (
    <div data-thread-column="" className="relative grid h-full min-h-0 grid-cols-1 grid-rows-1">
      <h1 className="sr-only">{title}</h1>
      <PillEdge />
      <TaskPill bot={bot} title={title} onBack={() => openBot()} />
      <Scroller top="pill" sent={sent}>
        {problem ? (
          <Problem text={problem} onRetry={conversation.retry} />
        ) : !view.loaded ? (
          <ConversationSkeleton />
        ) : (
          <SpadeChat
            bot={chatBot}
            view={view}
            // Spade asks a task's requests in main too, and takes the answer there.
            onAnswer={(callId, answer) =>
              spadeHttp(
                client,
                "POST",
                `/v1/conversations/${segment(bot.conversation)}/approvals/${segment(`${task}.${callId}`)}`,
                { body: { allowed: answer !== "deny", always: answer === "always" } },
              ).then(
                () => {
                  changed();
                  return true;
                },
                failed(`Couldn't answer ${title}`),
              )
            }
            onQuestion={(callId, reply) =>
              conversation.question(callId, reply).then(
                () => undefined,
                (error: unknown) => {
                  if (error instanceof SpadeRequestError && error.status === 400)
                    return error.message;
                  if (error instanceof SpadeRequestError && error.status === 409)
                    return "This question isn't open anymore.";
                  toast.error({ title: `Couldn't answer ${title}`, description: message(error) });
                  return "";
                },
              )
            }
            onOpenFile={openFile}
            onRetry={(reply) =>
              conversation.tryAgain(reply).then(() => {
                changed();
                return true;
              }, failed("Couldn't try again"))
            }
          />
        )}
      </Scroller>
      <SpadeComposer
        name={title}
        draftKey={`spade:${bot.machine.key}:${bot.id}:${task}`}
        answering={answering}
        onStop={stop}
        stopping={stopping}
        blocked={undefined}
        placeholder="Message this task"
        recall={(older) => spadeSentText(view.entries, older)}
        send={(outgoing) => {
          setSent((count) => count + 1);
          return conversation.send(outgoing).then(changed);
        }}
      />
    </div>
  );

  const showPanel = panelOpen && lane !== undefined;
  return (
    <ConversationScreen
      actions={
        !showPanel && (
          <Button size="sm" variant="ghost" onClick={() => setPanelOpen(true)}>
            Goal and plan
          </Button>
        )
      }
    >
      <div className="relative flex h-full min-h-0">
        <div
          className={cn("min-w-0 flex-1", showPanel && covering && "invisible")}
          aria-hidden={showPanel && covering ? true : undefined}
        >
          {chat}
        </div>
        {showPanel && lane && (
          <div
            style={covering ? undefined : { width: panelWidth.initial }}
            className={cn(
              "bg-panel",
              panelReveal,
              covering ? "absolute inset-0 z-20" : "relative shrink-0 border-l border-border",
            )}
          >
            <LanePanel
              main={bot.conversation}
              lane={lane}
              moved={moved}
              stopping={stopping}
              onStop={stop}
              onClose={() => setPanelOpen(false)}
              onOpenFile={openFile}
            />
          </div>
        )}
      </div>
    </ConversationScreen>
  );
}
