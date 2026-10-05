import { useThreadMeta } from "@ace/client-react";
import { accountLimit, describeWake, formatClock } from "@ace/ui-core";
import { useNow } from "@/lib/time.ts";
import { useThreadAccount } from "../lib/thread-account.ts";

const hour = 3_600_000;

/**
 * After the project in the header while the thread is held at its account's usage limit:
 * "· Limited until 3:20 PM" (with the day when it is further off), from the thread's own reset,
 * else its account's, else just "· Limited" when neither says.
 */
export function LimitBadge(props: { threadId: string }) {
  const status = useThreadMeta(props.threadId)?.status;
  const { account } = useThreadAccount(props.threadId);
  const now = useNow();
  if (status?.state !== "limited") return null;
  const until = status.until ?? (account && accountLimit(account, now).resetsAt);
  return (
    <span role="status">
      {" · Limited"}
      {until !== undefined &&
        until > now &&
        ` until ${until - now < 20 * hour ? formatClock(until) : describeWake(until, now)}`}
    </span>
  );
}
