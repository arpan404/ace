import { createFileRoute } from "@tanstack/react-router";
import { ProviderDetailScreen } from "@/features/settings/index.ts";

/** One provider's page: its sign-in, services, models and technical facts. */
export const Route = createFileRoute("/settings/providers/$provider")({
  component: function ProviderPage() {
    const { provider } = Route.useParams();
    return <ProviderDetailScreen id={provider} />;
  },
});
