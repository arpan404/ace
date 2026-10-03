import { createFileRoute } from "@tanstack/react-router";
import { Placeholder } from "@/components/placeholder.tsx";

export const Route = createFileRoute("/accounts")({
  component: () => (
    <Placeholder
      title="Accounts"
      description="Installed provider CLIs and their sign-in state will be listed here."
    />
  ),
});
