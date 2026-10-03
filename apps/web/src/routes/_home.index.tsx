import { createFileRoute } from "@tanstack/react-router";
import { HomeEmptyScreen } from "@/features/home/index.ts";

export const Route = createFileRoute("/_home/")({ component: HomeEmptyScreen });
