import { createFileRoute } from "@tanstack/react-router";
import { ArchivedScreen } from "@/features/home/index.ts";

/** Archived threads beside the Home list, with Restore and Delete. */
export const Route = createFileRoute("/_home/archived")({ component: ArchivedScreen });
