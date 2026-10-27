import { useClient } from "@ace/client-react";
import { projectRepository } from "@ace/ui-core/automations";
import { useQuery } from "@tanstack/react-query";
import { useProjectMetadata } from "@/lib/projects.ts";

/** The chosen project's GitHub repository, asked of the daemon once per project path. */
export function useProjectRepository(workspaceId: string): string | undefined {
  const client = useClient();
  const path = useProjectMetadata()(workspaceId)?.path;
  const query = useQuery({
    queryKey: ["automations", "project-repository", path],
    queryFn: async ({ signal }) => {
      const reply = await client.projects.inspect(path ?? "", { signal });
      return reply.result.kind === "inspection" ? (projectRepository(reply.result) ?? null) : null;
    },
    enabled: path !== undefined,
    staleTime: 5 * 60_000,
    retry: false,
  });
  return query.data ?? undefined;
}
