import { createFileRoute } from "@tanstack/react-router";
import { TrayPage } from "@/features/tray/index.ts";

/** The desktop app's menu-bar popover; the root draws it without the app's frame. */
export const Route = createFileRoute("/tray")({ component: TrayPage });
