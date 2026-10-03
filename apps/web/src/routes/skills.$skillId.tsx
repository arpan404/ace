import { createFileRoute } from "@tanstack/react-router";
import { SkillPage } from "@/features/skills/skill-page.tsx";

export const Route = createFileRoute("/skills/$skillId")({ component: Skill });

function Skill() {
  const { skillId } = Route.useParams();
  return <SkillPage key={skillId} skillId={skillId} />;
}
