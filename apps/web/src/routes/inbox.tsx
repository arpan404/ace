import { createFileRoute } from "@tanstack/react-router";
import { InboxPage } from "@/features/inbox/inbox-page.tsx";

export const Route = createFileRoute("/inbox")({ component: InboxPage });
