import {
  parseSpadeAgent,
  parseSpadeTask,
  parseSpadeTree,
  spadeAgentTaskMax,
  spadePermissionSwitches,
} from "@ace/ui-core/spade-chat";
import { z } from "zod";
import { spadeProfile, type SpadeProfileRow } from "./spade-profile.ts";
import { spadePermissionsOf, type SpadeProfilePermissions } from "./spade-profile-permissions.ts";
import { spadeProfileWork, type SpadeProfileWork } from "./spade-profile-work.ts";
import { segment } from "./spade-text.ts";
import {
  spadeRefused,
  spadeRequestArea,
  type SpadeOutcome,
  type SpadeRequestContext,
} from "./spade-requests-area.ts";

/*
 * A bot's profile sheet: read it and save the bot's task; its Permissions tab, read and one
 * switch written; and its Work tab. Each tab reads on its own as it shows, so one Spade can't
 * answer doesn't hold back the rest.
 */

const agentId = z.string().min(1).max(256);
const permissionKey = z.enum(
  spadePermissionSwitches.map((each) => each.key) as [
    (typeof spadePermissionSwitches)[number]["key"],
    ...(typeof spadePermissionSwitches)[number]["key"][],
  ],
);

const noBot = { ok: false, title: "", message: "Spade hasn't listed this bot yet." } as const;

/** A tab's read or write that went: what it shows now. */
type Part<T> = { ok: true; part: T };

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
    /** The Permissions tab's switches. */
    z.object({ type: z.literal("spade.permissions"), agentId }),
    /** One switch: on, off, or back to the default (`null`). */
    z.object({
      type: z.literal("spade.permission"),
      agentId,
      key: permissionKey,
      on: z.boolean().nullable(),
      confirmed: z.boolean().optional(),
    }),
    /** The Work tab: the goal and plan, the workers and the decisions. */
    z.object({ type: z.literal("spade.work"), agentId }),
  ],
  async (
    context,
    request,
  ): Promise<
    | SpadeOutcome
    | { ok: true; profile: SpadeProfileRow }
    | { ok: true; task: string }
    | Part<SpadeProfilePermissions>
    | Part<SpadeProfileWork>
  > => {
    const { spade, deps, ask } = context;
    const path = `/v1/agents/${segment(request.agentId)}`;
    switch (request.type) {
      case "spade.profile": {
        const bot = spade.bot(request.agentId);
        if (!bot) return noBot;
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
          const body = await ask("PATCH", path, { task });
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
      case "spade.permissions":
        try {
          return { ok: true, part: spadePermissionsOf(await ask("GET", `${path}/security`)) };
        } catch (error) {
          return spadeRefused("Couldn't read its permissions", error);
        }
      case "spade.permission":
        try {
          const body = await ask("PUT", `${path}/security/permissions`, {
            key: request.key,
            on: request.on,
          });
          return { ok: true, part: spadePermissionsOf(body) };
        } catch (error) {
          const refusal = spadeRefused("Couldn't change the permission", error);
          return {
            ...refusal,
            confirmPerson:
              !request.confirmed && refusal.message === "Confirm your identity to continue.",
          };
        }
      case "spade.work":
        return readWork(context, request.agentId, path);
    }
  },
);

/** The Work tab: the goal and tree read on their own; it fails only when both do. */
async function readWork(
  { spade, ask }: SpadeRequestContext,
  id: string,
  path: string,
): Promise<SpadeOutcome | Part<SpadeProfileWork>> {
  const bot = spade.bot(id);
  if (!bot) return noBot;
  const [task, tree] = await Promise.allSettled([
    ask("GET", `${path}/task`).then(parseSpadeTask),
    ask("GET", `${path}/tree`).then(parseSpadeTree),
  ]);
  if (task.status === "rejected" && tree.status === "rejected")
    return spadeRefused("Couldn't read its work", task.reason);
  const view = spade.follow(bot.conversation)?.get().view;
  const work = spadeProfileWork(
    task.status === "fulfilled" ? task.value : undefined,
    tree.status === "fulfilled" ? tree.value : undefined,
    view,
    bot.state !== "idle",
  );
  return { ok: true, part: work };
}
