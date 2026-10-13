import { ProviderAccountIcon } from "@/components/ui/provider-account-icon.tsx";
import type { ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import type { ThreadStatus } from "@ace/protocol";
import {
  ArrowClockwiseIcon,
  DotsThreeIcon,
  HourglassMediumIcon,
  MoonIcon,
  PauseIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { limitContext, modelName, queueNotice, type QueueNotice as Notice } from "@ace/ui-core";
import { Dot } from "@/components/ui/dot.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useNow } from "@/lib/time.ts";
import { useThreadAccount } from "../lib/thread-account.ts";
import type { QueueControls } from "./use-queue.ts";

import { useThreadModelAvailability } from "../lib/model-availability.ts";

const icons: Record<Notice["kind"], typeof PauseIcon> = {
  limited: HourglassMediumIcon,
  resuming: HourglassMediumIcon,
  snoozed: MoonIcon,
  restart: ArrowClockwiseIcon,
  stopped: PauseIcon,
  uncertain: WarningIcon,
  paused: PauseIcon,
  model: WarningIcon,
  not_sent: WarningIcon,
};

const holdOf = (reader: ThreadReader) => reader.queue;

/** Why the queue is held, with what the notice needs to say it; undefined while it isn't. */
export interface HeldQueue {
  notice: Notice;
  account: ReturnType<typeof useThreadAccount>["account"];
  unavailable: ReturnType<typeof useThreadModelAvailability>["unavailable"];
}

/**
 * Whether the queue is held: a usage limit (with when it resets), a restart that stopped the
 * agent, a manual pause, a model that went away, or a message that wasn't sent.
 */
export function useHeldQueue(
  threadId: string,
  status: ThreadStatus | undefined,
  queue: QueueControls,
): HeldQueue | undefined {
  const live = useThread(threadId, ["queue"], holdOf);
  const now = useNow();
  // What accounts.list says about the account it ran out on: its reset, and where Move goes.
  const { account, accounts } = useThreadAccount(threadId);
  const context = account && accounts ? limitContext(accounts, account.id, now) : undefined;
  const { unavailable } = useThreadModelAvailability(threadId);
  const notice = queueNotice(
    status,
    {
      ...(live ?? queue.page),
      pendingCount: live?.pendingCount ?? queue.page?.total ?? queue.messages.length,
      paused: live?.paused ?? queue.page?.paused ?? false,
      reason:
        (live?.reason ?? queue.page?.reason) === "model_unavailable" && !unavailable
          ? "not_sent"
          : (live?.reason ?? queue.page?.reason ?? null),
      resumeAt: live?.resumeAt ?? queue.page?.resumeAt ?? null,
    },
    now,
    undefined,
    context,
    unavailable,
  );
  return notice ? { notice, account, unavailable } : undefined;
}

/**
 * In the queue's strip while the queue is held: the reason and its way out (resume now, resume
 * at reset, snooze until reset, move to the account with the most room, or choose a model).
 * A message that wasn't sent is never said here: the transcript shows it (`HeldSend`).
 */
export function QueueNotice(props: {
  threadId: string;
  held: HeldQueue;
  queue: QueueControls;
  onChooseModel(): void;
}) {
  const { notice, account, unavailable } = props.held;
  const replacement = unavailable?.replacement;
  const detail =
    notice.kind === "model"
      ? `${replacement ? `Try ${modelName(replacement.provider, replacement.displayName, replacement.id)}. ` : ""}Queued messages send after you pick a model.`
      : notice.detail;
  const [primary, ...rest] = notice.actions;
  return (
    <section
      aria-label={notice.title}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1 py-1 text-ui"
    >
      <div className="flex min-w-0 basis-full items-start gap-2">
        {notice.kind === "model" ? (
          <Dot tone="needs-you" />
        ) : notice.kind === "limited" && account ? (
          <ProviderAccountIcon provider={account.provider} account={account} size={16} />
        ) : (
          <Icon
            icon={icons[notice.kind]}
            size={16}
            className="mt-0.5 shrink-0 text-muted-foreground"
          />
        )}
        <div className="min-w-0">
          <p className="font-medium text-foreground">{notice.title}</p>
          {detail && <p className="text-sm text-muted-foreground">{detail}</p>}
        </div>
      </div>
      <div className="flex items-center gap-1">
        {rest.length > 0 && (
          <Menu>
            <MenuTrigger
              render={<IconButton icon={DotsThreeIcon} label="Limit actions" size="sm" />}
            />
            <MenuContent side="top" align="end">
              {rest.map((action) => (
                <MenuItem
                  key={action.id}
                  disabled={props.queue.acting}
                  onClick={() => props.queue.act(action)}
                >
                  {action.label}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        )}
        {primary && (
          <Button
            size="sm"
            variant="ghost"
            disabled={props.queue.acting}
            onClick={() =>
              primary.id === "choose_model" ? props.onChooseModel() : props.queue.act(primary)
            }
          >
            {primary.label}
          </Button>
        )}
      </div>
    </section>
  );
}
