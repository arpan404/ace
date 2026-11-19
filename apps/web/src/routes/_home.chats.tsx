import { createFileRoute } from "@tanstack/react-router";
import { ChatsEmptyScreen } from "@/features/home/index.ts";

/** The Chats place (ADR 0099): the panel lists every chat; a chat opens at its thread's address. */
export const Route = createFileRoute("/_home/chats")({ component: ChatsEmptyScreen });
