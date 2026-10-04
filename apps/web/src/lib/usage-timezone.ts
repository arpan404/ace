import { UsageQuery } from "@ace/protocol";
import { knownTimeZone } from "@ace/ui-core";
import { useDaemonQuery } from "./daemon-query.ts";

/**
 * The time zone the daemon counts usage days in. Every usage reply names it; this asks once with
 * a one-day query. Until it is known `ready` is false; if the daemon can't say, or names a zone
 * this platform doesn't know, usage falls back to the device's zone (`timeZone` undefined).
 */
export function useUsageTimeZone(): { ready: boolean; timeZone: string | undefined } {
  const zone = useDaemonQuery({
    queryKey: ["usage", "timezone"],
    staleTime: Number.POSITIVE_INFINITY,
    read: async (client, signal) => {
      const query = UsageQuery.parse({ from: "2026-01-01", to: "2026-01-01", limit: 1 });
      const reply = await client.request({ type: "usage.summary", query }, { signal });
      return reply.result.timezone;
    },
  });
  return {
    ready: zone.data !== undefined || zone.isError,
    timeZone: knownTimeZone(zone.data),
  };
}
