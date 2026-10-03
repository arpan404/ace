import { createFileRoute } from "@tanstack/react-router";
import { FilesPage } from "@/features/files/files-page.tsx";

/** Changed files across threads, with download and upload. */
export const Route = createFileRoute("/more/files")({ component: FilesPage });
