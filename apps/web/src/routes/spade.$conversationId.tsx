import { createFileRoute } from "@tanstack/react-router";
import { SpadeConversationScreen } from "@/features/spade/index.ts";

/** One Spade conversation, live. */
export const Route = createFileRoute("/spade/$conversationId")({
  component: function SpadeConversationRoute() {
    const { conversationId } = Route.useParams();
    return <SpadeConversationScreen conversationId={conversationId} />;
  },
});
