import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { NewBotStart } from "@/features/spade/index.ts";

/**
 * New bot: a conversation with the bot it will be; its first message makes it. `template`: the
 * template it starts from, picked already (the empty list's templates).
 */
export const Route = createFileRoute("/spade/new")({
  validateSearch: z.object({
    template: z.string().max(80).optional().catch(undefined),
  }),
  component: function NewBot() {
    const { template } = Route.useSearch();
    return <NewBotStart template={template} />;
  },
});
