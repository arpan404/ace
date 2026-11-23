import { createFileRoute } from "@tanstack/react-router";
import { SpadeProviderScreen } from "@/features/spade/index.ts";

/** One of Spade's providers: its accounts, how each signs in, and the models bots may use. */
export const Route = createFileRoute("/settings/spade/models/$provider")({
  component: function SpadeProviderPage() {
    const { provider } = Route.useParams();
    return <SpadeProviderScreen id={provider} />;
  },
});
