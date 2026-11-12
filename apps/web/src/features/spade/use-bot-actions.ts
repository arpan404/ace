import { spadeBotFileName, type SpadeAgent } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/toast.tsx";
import { deleteAgent } from "./spade-api.ts";
import { saveAs } from "./save-as.ts";
import { duplicateAgent, exportAgent } from "./spade-teams-api.ts";
import { agentsKey } from "./use-spade-roster.ts";
import { useSpadeClient } from "./spade-machine.tsx";

/** Deletes a bot on the machine in scope; resolves whether it went, and says why it didn't. */
export function useDeleteBot() {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const toast = useToast();
  return async (bot: { id: string; name: string }): Promise<boolean> => {
    try {
      await deleteAgent(client, bot.id);
      await cache.invalidateQueries({ queryKey: agentsKey });
      return true;
    } catch (error) {
      toast.error({
        title: `Couldn't delete ${bot.name}`,
        description: error instanceof Error ? error.message : "Try again.",
      });
      return false;
    }
  };
}

/** Copies a bot on the machine in scope; resolves with the copy, or undefined after saying why. */
export function useDuplicateBot() {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const toast = useToast();
  return async (bot: { id: string; name: string }): Promise<SpadeAgent | undefined> => {
    try {
      const copy = await duplicateAgent(client, bot.id);
      await cache.invalidateQueries({ queryKey: agentsKey });
      return copy;
    } catch (error) {
      toast.error({ title: `Couldn't duplicate ${bot.name}`, description: fault(error) });
      return undefined;
    }
  };
}

/** Saves a bot's file as `<name>.spade-bot.json`, as Spade wrote it. */
export function useExportBot() {
  const client = useSpadeClient();
  const toast = useToast();
  return async (bot: { id: string; name: string }): Promise<void> => {
    try {
      const file = await exportAgent(client, bot.id);
      saveAs(new Blob([file], { type: "application/json" }), spadeBotFileName(bot.name));
    } catch (error) {
      toast.error({ title: `Couldn't export ${bot.name}`, description: fault(error) });
    }
  };
}

const fault = (error: unknown) => (error instanceof Error ? error.message : "Try again.");
