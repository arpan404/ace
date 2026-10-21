import type { AccessMode, Automation } from "@ace/protocol";
import { ClockIcon, TrashIcon } from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useThreadMeta } from "@ace/client-react";
import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { LoadingRegion, Skeleton, SkeletonText } from "@/components/ui/skeleton.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { Screen } from "@/features/shell/index.ts";
import { readingColumn } from "@/features/thread/index.ts";
import { cn } from "@/lib/cn.ts";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useProjectName } from "@/lib/projects.ts";
import { useNow } from "@/lib/time.ts";
import { NextRun } from "@/features/automation-data/index.ts";
import { withModel } from "./automation-model.ts";
import type { AutomationEntry } from "@/features/automation-data/index.ts";
import { ConversationComposer } from "./conversation-composer.tsx";
import { ConversationRuns } from "./conversation-runs.tsx";
import { ConversationStatus } from "./conversation-status.tsx";
import { RenameDialog } from "./rename-dialog.tsx";
import { normalizeDaemonKey } from "@/features/automation-data/index.ts";
import { describeWhen, localTimeZone } from "@/features/automation-schedule/index.ts";
import { useAutomationControls } from "./use-automation-controls.ts";
import { useAutomation } from "@/features/automation-data/index.ts";

/** The person's message, as the thread shows it: a tailless bubble at the answers' size. */
const promptBubble =
  "relative max-w-[80%] min-w-0 overflow-hidden rounded-lg bg-bubble px-3 py-2 font-prose text-prose wrap-break-word whitespace-pre-wrap";

/**
 * One automation as a conversation: a pinned header (name, when it runs, the switch), the
 * prompt once as the person's message, then every run as a turn, and at the bottom a composer
 * with the automation's own model and access. Sending runs it now with that note.
 */
export function AutomationScreen(props: { id: string }) {
  const { entry, pending, error, retry } = useAutomation(props.id);
  const { url } = useDaemonConnection();
  const daemonKey = normalizeDaemonKey(url);
  if (!entry)
    return (
      <Screen title="Automation">
        {pending ? (
          <div className={cn(readingColumn, "pt-6")}>
            <LoadingRegion label="automation" className="flex flex-col gap-3">
              <Skeleton className="h-6 w-72" />
              <Skeleton className="h-3.5 w-48" />
              <SkeletonText lines={4} className="mt-8" />
            </LoadingRegion>
          </div>
        ) : (
          <EmptyState
            icon={ClockIcon}
            title={error ? "Couldn't load this automation" : "Automation not found"}
            description={
              error
                ? "Couldn't connect. This loads again when the connection is back."
                : "It may have been deleted on another device."
            }
            action={
              error ? (
                <Button size="sm" onClick={retry}>
                  Try again
                </Button>
              ) : undefined
            }
          />
        )}
      </Screen>
    );
  return (
    <Conversation
      key={`${daemonKey}:${entry.owner ?? ""}:${entry.automation.id}`}
      entry={entry}
      daemonKey={daemonKey}
      refetch={retry}
    />
  );
}

function Conversation(props: { entry: AutomationEntry; daemonKey: string; refetch(): void }) {
  const { entry } = props;
  const navigate = useNavigate();
  const controls = useAutomationControls(entry, props.daemonKey, props.refetch);
  const [running] = useDaemonSetting("automations.enabled");
  const now = useNow();
  const projectName = useProjectName();
  const [renaming, setRenaming] = useState(false);
  // A change in flight shows at once; the stored definition takes over at its next revision.
  const [draft, setDraft] = useState<{ automation: Automation; revision: number | undefined }>();
  const automation =
    draft && draft.revision === entry.revision ? draft.automation : entry.automation;
  const own = controls.source === "person";
  const timezone =
    automation.trigger.kind === "schedule" ? automation.trigger.schedule.timezone : undefined;
  const runBlocked = !controls.ready
    ? "Reconnect to run this automation."
    : !automation.enabled
      ? "Resume this automation to run it."
      : running === false
        ? "Automations are off on this machine."
        : undefined;
  const change = (next: Automation) => {
    setDraft({ automation: next, revision: entry.revision });
    void controls.update(next).then((saved) => {
      if (!saved) setDraft(undefined);
    });
  };
  const scroller = useScrollToEnd();
  return (
    <Screen
      title={automation.title}
      menu={
        <>
          <MenuItem
            disabled={!!runBlocked || controls.busy}
            onClick={() => void controls.startRun()}
          >
            Run now
          </MenuItem>
          {own && (
            <>
              <MenuItem
                disabled={controls.busy || !controls.ready}
                onClick={() => setRenaming(true)}
              >
                Rename
              </MenuItem>
              <MenuItem
                onClick={() =>
                  void navigate({
                    to: "/automations/$automationId/edit",
                    params: { automationId: automation.id },
                  })
                }
              >
                Edit when
              </MenuItem>
              <MenuItem disabled={controls.busy || !controls.ready} onClick={controls.duplicate}>
                Duplicate
              </MenuItem>
            </>
          )}
          <MenuItem
            danger
            disabled={controls.busy || !controls.ready}
            icon={<Icon icon={TrashIcon} />}
            onClick={controls.remove}
          >
            Delete
          </MenuItem>
        </>
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        <div
          ref={scroller}
          className="min-h-0 flex-1 overflow-y-auto pb-8 [scrollbar-gutter:stable]"
        >
          <div className={readingColumn}>
            <header className="sticky top-0 z-10 flex items-start gap-4 bg-background pt-6 pb-4">
              <div className="min-w-0 flex-1">
                <h2 className="text-xl font-semibold tracking-title break-words">
                  {automation.title}
                </h2>
                <p className="mt-1 text-ui text-muted-foreground">
                  {describeWhen(automation.trigger, localTimeZone())} ·{" "}
                  <span className="text-foreground">
                    <NextRun
                      automation={automation}
                      nextRunAt={entry.nextRunAt}
                      now={now}
                      running={running}
                    />
                  </span>{" "}
                  · {projectName(automation.workspace)}
                  {entry.owner && <OwnerLink threadId={entry.owner} />}
                </p>
              </div>
              <Switch
                aria-label="Enabled"
                className="mt-1.5"
                checked={automation.enabled}
                disabled={controls.busy || !controls.ready}
                onCheckedChange={(checked) => controls.toggle(checked)}
              />
            </header>
            <div className="mt-4 flex justify-end">
              <div aria-label="Prompt" role="group" className={promptBubble}>
                {automation.prompt}
              </div>
            </div>
            <ConversationRuns
              automationId={automation.id}
              source={controls.source}
              timezone={timezone}
              onRunAgain={() => void controls.startRun()}
              runDisabled={!!runBlocked || controls.busy}
            />
            <ConversationStatus entry={entry} controls={controls} runBlocked={runBlocked} />
          </div>
        </div>
        <div className={cn(readingColumn, "shrink-0 pb-[max(1rem,env(safe-area-inset-bottom))]")}>
          <ConversationComposer
            automation={automation}
            controls={controls}
            runBlocked={runBlocked}
            settings={
              own
                ? {
                    onModel: (fields) => change(withModel(automation, fields)),
                    onAccess: (access: AccessMode) => change({ ...automation, access }),
                  }
                : undefined
            }
          />
        </div>
      </div>
      <RenameDialog
        open={renaming}
        title={automation.title}
        onClose={() => setRenaming(false)}
        onRename={(title) => controls.update({ ...automation, title })}
      />
    </Screen>
  );
}

/** Opens on the newest turn, and follows new turns while the reader is at the bottom. */
function useScrollToEnd() {
  const element = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const scroller = element.current;
    if (!scroller) return;
    const content = scroller.firstElementChild;
    const follow = () => {
      if (pinned.current) scroller.scrollTop = scroller.scrollHeight;
    };
    const onScroll = () => {
      pinned.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
    };
    follow();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" || !content ? undefined : new ResizeObserver(follow);
    if (content) observer?.observe(content);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, []);
  return element;
}

/** " · from Fix flaky checkout test": the thread whose agent made this automation. */
function OwnerLink(props: { threadId: string }) {
  const title = useThreadMeta(props.threadId)?.title;
  return (
    <>
      {" · from "}
      <Link
        to="/t/$threadId"
        params={{ threadId: props.threadId }}
        className="rounded-xs text-foreground focus-ring hover:underline"
      >
        {title || "its thread"}
      </Link>
    </>
  );
}
