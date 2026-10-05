import type { AutomationRun } from "@ace/protocol";
import {
  ArrowSquareOutIcon,
  AtIcon,
  CheckIcon,
  EnvelopeOpenIcon,
  EnvelopeSimpleIcon,
  GitMergeIcon,
  LinkIcon,
  WarningIcon,
  XIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { Icon } from "@/components/icon.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { automationRunSummary } from "@/features/automations/index.ts";
import { useProjectName } from "@/lib/projects.ts";
import { useNow } from "@/lib/time.ts";
import { formatAge } from "@ace/ui-core";
import { eventKey, runKey, useActivityState } from "./activity-state.tsx";
import { FeedRow } from "./feed-row.tsx";
import { useFeedSource, type FeedEvent, type FeedKind } from "./feed-source.ts";

const eventIcons: Record<FeedKind, PhosphorIcon> = {
  escalation: WarningIcon,
  mention: AtIcon,
  ci: XIcon,
  pr: GitMergeIcon,
};

/** Copies `/activity?item=…` for this item. */
function useCopyItemLink() {
  const toast = useToast();
  return (key: string) => {
    const link = new URL(`/activity?item=${encodeURIComponent(key)}`, location.href).href;
    const copied =
      navigator.clipboard?.writeText(link) ?? Promise.reject(new Error("no clipboard"));
    void copied.then(
      () => toast.add({ title: "Link copied" }),
      () => toast.error({ title: "Couldn't copy the link" }),
    );
  };
}

/** The row's right-click menu: read state, the thread, and a link to the item. */
function ItemMenu(props: {
  itemKey: string;
  readId: string;
  read: boolean;
  threadId: string | undefined;
}) {
  const source = useFeedSource();
  const navigate = useNavigate();
  const copy = useCopyItemLink();
  return (
    <>
      <MenuItem
        icon={<Icon icon={props.read ? EnvelopeSimpleIcon : EnvelopeOpenIcon} />}
        keys={props.read ? "u" : "e"}
        onClick={() =>
          props.read ? source.markUnread([props.readId]) : source.markRead([props.readId])
        }
      >
        {props.read ? "Mark unread" : "Mark read"}
      </MenuItem>
      {props.threadId && (
        <MenuItem
          icon={<Icon icon={ArrowSquareOutIcon} />}
          onClick={() =>
            void navigate({ to: "/t/$threadId", params: { threadId: props.threadId ?? "" } })
          }
        >
          Open thread
        </MenuItem>
      )}
      <MenuItem icon={<Icon icon={LinkIcon} />} onClick={() => copy(props.itemKey)}>
        Copy link
      </MenuItem>
    </>
  );
}

/**
 * A mention, CI or pull-request event: selecting it shows it on its own in the main column
 * and marks it read. A deck's decision focuses its card in Needs you instead.
 */
export function EventItemRow(props: { event: FeedEvent; read: boolean }) {
  const { event } = props;
  const state = useActivityState();
  const source = useFeedSource();
  const now = useNow();
  const projectName = useProjectName();
  const key = eventKey(event.id);
  const needsYou = event.kind === "escalation";
  const select = () => {
    if (needsYou) return state.setFocused(key);
    source.markRead([event.id]);
    state.selectItem(key);
  };
  return (
    <FeedRow
      icon={<Icon icon={eventIcons[event.kind]} size={16} />}
      title={event.title}
      description={`${projectName(event.project)} · ${event.context}`}
      age={formatAge(event.at, now)}
      mark={needsYou ? "needs-you" : props.read ? undefined : "unread"}
      selected={needsYou ? state.focused === key && !state.item : state.item === key}
      onSelect={select}
      picked={state.picked.has(key)}
      onPick={() => state.togglePicked(key)}
      {...(needsYou ? {} : { readId: event.id })}
      menu={
        needsYou ? undefined : (
          <ItemMenu itemKey={key} readId={event.id} read={props.read} threadId={event.threadId} />
        )
      }
    />
  );
}

/** An automation's run: its outcome mark and what it found; selecting it shows it. */
export function RunItemRow(props: { run: AutomationRun; read: boolean }) {
  const { run } = props;
  const state = useActivityState();
  const source = useFeedSource();
  const now = useNow();
  const key = runKey(run.id);
  return (
    <FeedRow
      icon={
        run.status === "running" ? (
          <Spinner />
        ) : (
          <Icon icon={run.status === "failed" ? WarningIcon : CheckIcon} size={16} />
        )
      }
      title={run.title}
      description={automationRunSummary(run)}
      age={formatAge(run.finishedAt ?? run.startedAt, now)}
      mark={props.read ? undefined : "unread"}
      selected={state.item === key}
      onSelect={() => {
        source.markRead([run.id]);
        state.selectItem(key);
      }}
      picked={state.picked.has(key)}
      onPick={() => state.togglePicked(key)}
      readId={run.id}
      menu={<ItemMenu itemKey={key} readId={run.id} read={props.read} threadId={run.threadId} />}
    />
  );
}
