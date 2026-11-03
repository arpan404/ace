import type { ThreadListEntry } from "@ace/protocol";
import {
  cardDetails,
  currentAttention,
  hoverStatusLine,
  threadCard,
  threadLiveFact,
  type AccountView,
} from "@ace/ui-core";
import { agentUseMarks, type AgentUse } from "./inbox-agent-use.ts";

/*
 * The desktop row's and hover card's facts for one inbox row, from the shared card
 * (`threadCard`): the branch cut in the middle, the lines changed, every linked pull request
 * with its repository and title, the hover card's status sentence, the account's name and what
 * an agent drives for the thread. Swift draws them as given. Pure.
 */

export interface RowCardContext {
  baseline: number;
  now: number;
  /** The row shows as settled (`inboxLook`). */
  settled: boolean;
  accounts: readonly AccountView[];
  use: AgentUse;
}

export function rowCard(entry: ThreadListEntry, context: RowCardContext) {
  const card = threadCard({
    entry,
    details: cardDetails(entry, undefined),
    baseline: context.baseline,
    settled: context.settled,
    now: context.now,
    projectName: entry.details?.workspace?.name,
  });
  const line = hoverStatusLine({
    attention: currentAttention(card.attention, true),
    card,
    fact: threadLiveFact(entry),
  });
  const instance = entry.execution?.instanceId ?? entry.live?.account;
  return {
    /** The branch as the row's last line shows it: "work/re…treams". */
    branchLabel: card.branch?.label ?? null,
    /** Lines added and removed, only when the thread changed some. */
    work: card.diff ?? null,
    /** Every pull request the thread links, for the preview: number, state, repository, title. */
    prs: (card.prs ?? []).map((pr) => ({
      number: pr.number,
      state: pr.state,
      repo: `${pr.repo.owner}/${pr.repo.name}`,
      title: pr.title ?? null,
    })),
    /** The preview's status sentence ("Waiting for approval"), its detail and its ink. */
    hover: line.sentence
      ? {
          sentence: line.sentence,
          detail: line.detail?.text ?? null,
          code: line.detail?.code === true,
          ink: line.ink,
        }
      : null,
    /** The account the thread runs on, by its name ("Work"), where the machine knows it. */
    accountLabel: context.accounts.find((account) => account.id === instance)?.label ?? null,
    ...agentUseMarks(context.use, entry.id),
  };
}
