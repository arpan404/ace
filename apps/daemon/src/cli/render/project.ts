import type { Project } from "@ace/protocol";

/** One project per line: name, id, folder. Pure. */
export function projectListLines(projects: readonly Project[], next: string | null): string[] {
  if (!projects.length) return ["No projects yet. Add this folder with ace project add."];
  const nameWidth = Math.min(24, Math.max(...projects.map((project) => project.name.length)));
  const idWidth = Math.max(...projects.map((project) => project.id.length));
  const lines = projects.map((project) =>
    [project.name.padEnd(nameWidth), project.id.padEnd(idWidth), project.path].join("  "),
  );
  if (next) lines.push(`More: ace project list --after ${next}`);
  return lines;
}

export interface ProjectShowView {
  readonly project: Project;
  readonly threads: { readonly total: number; readonly needsYou: number; readonly running: number };
}

/** One project: its name and folder, then its threads in one line. Pure. */
export function projectShowLines(view: ProjectShowView): string[] {
  const { project, threads } = view;
  const counts = [
    `${threads.total} ${threads.total === 1 ? "thread" : "threads"}`,
    threads.needsYou ? `${threads.needsYou} need you` : "",
    threads.running ? `${threads.running} working` : "",
  ].filter(Boolean);
  return [
    project.name,
    `${project.id}  ${project.path}`,
    counts.join(" · "),
    ...(threads.total ? [`See them with ace thread list --project ${project.id}`] : []),
  ];
}
