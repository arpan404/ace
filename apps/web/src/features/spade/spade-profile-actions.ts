import { storedBotFace } from "@ace/ui-core/bot-face";
import { spadeBotFileName } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/toast.tsx";
import { editAgent, type SpadeAgentDraft } from "./spade-api.ts";
import type { AvatarDraft } from "./spade-avatar-choice.tsx";
import { useSpadeClient } from "./spade-machine.tsx";
import { saveAs } from "./save-as.ts";
import { exportAgent } from "./spade-teams-api.ts";
import { agentsKey } from "./use-spade-roster.ts";

/*
 * What the profile changes on a bot in place: one field at a time, each sent as it is saved.
 */

/** The avatar a draft sends: its picture, or its face as stored; nothing while it is unchanged. */
export const sentAvatar = (draft: AvatarDraft): SpadeAgentDraft["avatar"] | undefined => {
  if (draft.kind === "image") return draft;
  if (draft.kind === "face") return storedBotFace(draft.face, draft.raw);
  return undefined;
};

export const fault = (error: unknown) => (error instanceof Error ? error.message : "Try again.");

/**
 * Saves one change to a bot and reads the roster again; resolves with Spade's refusal in words,
 * or undefined once it is saved, so the field that sent it can say why where it is.
 */
export function useEditBot(bot: { id: string }) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  return async (
    change: Partial<SpadeAgentDraft> & {
      task_why?: string;
      may_create_bots?: "yes" | "ask" | "no";
    },
  ): Promise<string | undefined> => {
    try {
      await editAgent(client, bot.id, change);
      await cache.invalidateQueries({ queryKey: agentsKey });
      return undefined;
    } catch (error) {
      return fault(error);
    }
  };
}

/**
 * Share: the bot's file, as Spade exports it, handed to the system's share sheet where the
 * browser has one for files, else saved like Export.
 */
export function useShareBot() {
  const client = useSpadeClient();
  const toast = useToast();
  return async (bot: { id: string; name: string }): Promise<void> => {
    let text: string;
    try {
      text = await exportAgent(client, bot.id);
    } catch (error) {
      toast.error({ title: `Couldn't share ${bot.name}`, description: fault(error) });
      return;
    }
    const name = spadeBotFileName(bot.name);
    const file = new File([text], name, { type: "application/json" });
    const share = typeof navigator === "undefined" ? undefined : navigator;
    if (share?.canShare?.({ files: [file] })) {
      try {
        await share.share({ files: [file], title: bot.name });
      } catch {
        // Dismissed, or the sheet refused: nothing was shared, and nothing to say.
      }
      return;
    }
    saveAs(file, name);
  };
}
