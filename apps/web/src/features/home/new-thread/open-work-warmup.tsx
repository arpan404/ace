import { useEffect, useState } from "react";
import {
  useFailingPullRequests,
  useOpenIssues,
  useOpenPullRequests,
} from "@/features/forge/index.ts";
import { useOrganizerState } from "@/features/organize/index.ts";
import { whenIdle } from "@/lib/idle.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useRegisteredProjects } from "@/lib/projects.ts";
import { loadChoices, pickProject } from "./choices.ts";

/**
 * Loads the open pull requests and issues of the project New thread would open on, once the app
 * is idle, and keeps them cached, so New thread shows them at once instead of after a GitHub round
 * trip. It renders nothing; it reads only what New thread itself reads first.
 */
export function OpenWorkWarmup() {
  const { storage } = useLayout();
  const { project: filter } = useOrganizerState();
  const { ids: projects, loaded } = useRegisteredProjects();
  const [idle, setIdle] = useState(false);
  useEffect(() => whenIdle(() => setIdle(true)), []);
  const project = loaded
    ? pickProject(projects, undefined, loadChoices(storage).project, filter)
    : undefined;
  if (!idle || !project) return null;
  return <Warm key={project} project={project} />;
}

function Warm(props: { project: string }) {
  useOpenPullRequests(props.project);
  useFailingPullRequests(props.project);
  useOpenIssues(props.project);
  return null;
}
