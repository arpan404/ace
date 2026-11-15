import type { SuitPort } from "@ace/mcp-server";
import type { SuitResponse } from "@ace/protocol/suits";
import type { SuitLiveChecks } from "./live-checks.ts";
import type { SuitLooks } from "./looks.ts";

/** What the port needs of the Suit library. */
export interface SuitChecks {
  validate(id: string): Promise<SuitResponse>;
}

/**
 * `suit_apply`'s view of the daemon (ADR 0150): checks from the library, looks through the hub.
 * Live checks go to the devices that may read the thread and come back through `checks`. All
 * are read when called, so the tool works once the Suit service is up.
 */
export function daemonSuitPort(
  library: () => SuitChecks | undefined,
  looks: () => SuitLooks | undefined,
  liveChecks: () => SuitLiveChecks | undefined = () => undefined,
): SuitPort {
  const hub = () => {
    const found = looks();
    if (!found) throw new Error("Suits aren't ready yet");
    return found;
  };
  return {
    async validate(id) {
      const checks = library();
      if (!checks) return undefined;
      const response = await checks.validate(id);
      if (response.op === "validate") return response.summary;
      // A Suit whose suit.json doesn't parse still has a summary saying why.
      return response.op === "error" ? response.summary : undefined;
    },
    async preview(caller, id) {
      hub().preview(caller.threadId, id);
    },
    async keep(caller, id) {
      const { restore } = hub().keep(caller.threadId, id);
      return { restore: async () => restore() };
    },
    async liveCheck(caller, id, signal) {
      const live = liveChecks();
      const devices = looks();
      if (!live || !devices) return [];
      return live.run(
        id,
        (checkId) => devices.askCheck(caller.threadId, { checkId, suitId: id }),
        signal,
      );
    },
  };
}
