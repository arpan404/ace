import { createFileRoute } from "@tanstack/react-router";
import { ForgeLanding } from "@/features/forge-pages/index.ts";

/** Pull requests opens on the first row of its list. */
export const Route = createFileRoute("/_forge/pulls/")({
  component: () => <ForgeLanding kind="pulls" />,
});
