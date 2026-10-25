import { subscribeSettings, type RetryTimers, type SettingsOwner } from "@ace/client";
import { SettingsValues } from "@ace/protocol";
import { homeSortOptions, type HomeSort } from "@ace/ui-core";

/*
 * The machine's `threads.sortBy`, the setting the web's Home list follows, kept live for the
 * inbox: read when the connection is ready, then pushed on every change from any device. Until
 * it is read, and if it can't be, the inbox keeps the sort the phone last drew it in (kept with
 * the inbox checkpoint), else live activity, as Home sorts by default.
 */

const SortBy = SettingsValues.shape["threads.sortBy"];
const key = "threads.sortBy";
/** Followers on one socket each own their subscription. */
let followers = 0;

export interface InboxSort {
  current(): HomeSort;
  stop(): void;
}

export function followInboxSort(
  owner: SettingsOwner,
  timers: RetryTimers,
  last: HomeSort | undefined,
  changed: () => void,
): InboxSort {
  let sortBy: HomeSort = last ?? "activity";
  const subscription = subscribeSettings(
    owner,
    `ios-inbox-sort-${++followers}`,
    [key],
    {},
    (entries) => {
      const entry = entries.find((candidate) => candidate.key === key);
      if (!entry) return;
      const parsed = SortBy.safeParse(entry.value);
      const next = parsed.success ? parsed.data : "activity";
      if (next === sortBy) return;
      sortBy = next;
      changed();
    },
    () => {},
    timers,
  );
  return { current: () => sortBy, stop: subscription.stop };
}

/** The choices the inbox's menu offers, worded as the web's Settings words them. */
export const inboxSortChoices = homeSortOptions.map((option) => ({
  id: option.id,
  label: option.label,
}));
