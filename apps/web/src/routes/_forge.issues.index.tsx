import { createFileRoute } from "@tanstack/react-router";
import { ForgeLanding } from "@/features/forge-pages/index.ts";

/** Issues opens on the first row of its list. */
export const Route = createFileRoute("/_forge/issues/")({
  component: () => <ForgeLanding kind="issues" />,
});
