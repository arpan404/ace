import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/toast.tsx";
import { deleteAgent } from "./spade-api.ts";
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
