import { createFileRoute, Navigate } from "@tanstack/react-router";

// Before authentication the connection gate owns /pair. After welcome, open the thread list.
export const Route = createFileRoute("/pair")({ component: () => <Navigate to="/" replace /> });
