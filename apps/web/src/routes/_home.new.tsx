import { createFileRoute } from "@tanstack/react-router";
import { NewThread } from "@/features/thread/new-thread.tsx";

/** ⌘N: pick a project and a model; the thread is created when the first message is sent. */
export const Route = createFileRoute("/_home/new")({ component: NewThread });
