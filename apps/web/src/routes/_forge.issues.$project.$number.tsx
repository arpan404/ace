import { createFileRoute } from "@tanstack/react-router";
import { IssuePage } from "@/features/forge-pages/index.ts";

export const Route = createFileRoute("/_forge/issues/$project/$number")({ component: Issue });

function Issue() {
  const { project, number } = Route.useParams();
  const parsed = Number(number);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return <IssuePage key={`${project}#${parsed}`} project={project} number={parsed} />;
}
