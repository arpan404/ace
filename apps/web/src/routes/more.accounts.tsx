import { createFileRoute } from "@tanstack/react-router";
import { AccountsPage } from "@/features/accounts/index.ts";

/** Accounts per provider, quota rings, usage over time and the scheduling policy. */
export const Route = createFileRoute("/more/accounts")({ component: AccountsPage });
