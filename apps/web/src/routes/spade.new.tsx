import { createFileRoute } from "@tanstack/react-router";
import { NewBotStart } from "@/features/spade/index.ts";

/** New bot: a conversation with the bot it will be; its first message makes it. */
export const Route = createFileRoute("/spade/new")({ component: NewBotStart });
