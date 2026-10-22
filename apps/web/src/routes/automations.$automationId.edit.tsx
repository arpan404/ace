import { createFileRoute, redirect } from "@tanstack/react-router";

/** Editing happens in place on the automation; an old link to its edit page lands there. */
export const Route = createFileRoute("/automations/$automationId/edit")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/automations/$automationId",
      params: { automationId: params.automationId },
      replace: true,
    });
  },
});
