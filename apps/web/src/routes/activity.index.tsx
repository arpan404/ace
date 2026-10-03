import { createFileRoute } from "@tanstack/react-router";
import { ActivityScreen } from "@/features/activity/index.ts";

export const Route = createFileRoute("/activity/")({ component: ActivityScreen });
