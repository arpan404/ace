import { useItem } from "@ace/client-react";
import { Link } from "@tanstack/react-router";
import { sharesLine } from "@ace/ui-core";
import { useMachineSearch } from "@/lib/machine-routes.ts";
import { userBubble } from "../items/user-bubble.ts";
import { MentionMark } from "./mention-mark.tsx";
import { addresseePicture } from "./token-picture.ts";
import { stateWords } from "./asked-words.ts";

/**
 * ace's line under a message the person sent with `@` bots, clubs or agents (ADR 0198): each
 * addressee's face and where it stands, in words, then what went with it. A follow-up shows its
 * own words above, since only the bots got them. A bot waiting for the person links to its chat
 * in Spade, where the approval is; an agent links to its thread.
 */
export function AskedLine(props: { threadId: string; itemId: string }) {
  const item = useItem(props.threadId, props.itemId);
  const search = useMachineSearch();
  const line = item?.type === "notice" ? item.asked : undefined;
  if (!line || (!line.to.length && !line.words)) return null;
  return (
    <div
      data-part="asked-line"
      className="flex flex-col items-end gap-1 text-xs text-muted-foreground [[data-layout-messages=flat]_&]:items-start"
    >
      {line.words && <p className={userBubble}>{line.words}</p>}
      <ul className="flex max-w-[80%] flex-wrap justify-end gap-x-3 gap-y-0.5">
        {line.to.map((entry) => (
          <li
            key={entry.to.kind === "agent" ? entry.to.threadId : entry.to.id}
            className="flex min-w-0 items-center gap-1.5"
          >
            <span className="grid size-3.5 shrink-0 place-items-center">
              <MentionMark picture={addresseePicture(entry.to)} size={14} />
            </span>
            <span className="truncate" role={entry.state === "answering" ? "status" : undefined}>
              {stateWords(entry)}
            </span>
            {entry.state === "waiting" && entry.to.kind !== "agent" && (
              <Link
                to={entry.to.kind === "bot" ? "/spade/$agentId" : "/spade/groups/$groupId"}
                params={
                  entry.to.kind === "bot" ? { agentId: entry.to.id } : { groupId: entry.to.id }
                }
                className="focus-ring rounded-sm font-medium text-link"
              >
                Open in Spade
              </Link>
            )}
            {entry.to.kind === "agent" && entry.state === "sent" && (
              <Link
                to="/t/$threadId"
                params={{ threadId: entry.to.threadId }}
                search={search}
                className="focus-ring rounded-sm font-medium text-link"
              >
                Open
              </Link>
            )}
          </li>
        ))}
      </ul>
      {line.to.some((entry) => entry.to.kind !== "agent") && line.shares.length > 0 && (
        <p className="max-w-[80%] truncate text-subtle-foreground">{sharesLine(line.shares)}</p>
      )}
    </div>
  );
}
