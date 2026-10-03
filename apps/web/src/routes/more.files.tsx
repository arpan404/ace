import { createFileRoute } from "@tanstack/react-router";
import { FilesPage } from "@/features/files/index.ts";

/** Changed files across threads, with download and upload. */
export const Route = createFileRoute("/more/files")({ component: FilesPage });
