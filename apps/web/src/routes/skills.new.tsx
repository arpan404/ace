import { createFileRoute } from "@tanstack/react-router";
import { NewSkillPage } from "@/features/skills/index.ts";

export const Route = createFileRoute("/skills/new")({ component: NewSkillPage });
