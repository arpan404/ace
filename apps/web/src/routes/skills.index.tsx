import { createFileRoute } from "@tanstack/react-router";
import { SkillsLandingScreen } from "@/features/skills/index.ts";

/** Skills opens on the first entry of the catalog. */
export const Route = createFileRoute("/skills/")({ component: SkillsLandingScreen });
