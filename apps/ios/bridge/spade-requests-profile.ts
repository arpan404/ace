import { parseSpadeAgent, spadeAgentTaskMax } from "@ace/ui-core/spade-chat";
import { z } from "zod";
import { spadeProfile, type SpadeProfileRow } from "./spade-profile.ts";
import { segment } from "./spade.ts";
import { spadeRefused, spadeRequestArea, type SpadeOutcome } from "./spade-requests-area.ts";

/* A bot's profile sheet: read it, and save the bot's task. */

const agentId = z.string().min(1).max(256);

export const spadeProfileRequests = spadeRequestArea(
  [
    /** A bot's profile, read afresh each time its sheet opens or is pulled. */
    z.object({ type: z.literal("spade.profile"), agentId }),
    /** The bot's task, as the person wrote it on its profile. */
    z.object({
      type: z.literal("spade.task"),
      agentId,
      // Spade's limit is in code points, and so is Zod's `max` on a string (not UTF-16 units).
      task: z.string().max(spadeAgentTaskMax),
    }),
  ],
  async (
    { spade, deps, ask },
    request,
  ): Promise<
    SpadeOutcome | { ok: true; profile: SpadeProfileRow } | { ok: true; task: string }
  > => {
    switch (request.type) {
      case "spade.profile": {
        const bot = spade.bot(request.agentId);
        if (!bot) return { ok: false, title: "", message: "Spade hasn't listed this bot yet." };
        const profile = await spadeProfile(
          bot,
          spade.machineName,
          (route) => ask("GET", route),
          deps.now(),
        );
        return { ok: true, profile };
      }
      case "spade.task":
        try {
          const task = request.task.trim();
          const body = await ask("PATCH", `/v1/agents/${segment(request.agentId)}`, { task });
          // The write says what Spade now holds: the profile opened next shows it at once, not the
          // list as last read while the refresh is still on its way.
          const stored = parseSpadeAgent(body)?.task ?? task;
          spade.saved(request.agentId, stored);
          spade.refresh();
          // The task as Spade stored it, for the profile to show whatever its next read brings.
          return { ok: true, task: stored };
        } catch (error) {
          return spadeRefused("Couldn't save the task", error);
        }
    }
  },
);
