import * as z from "zod/mini";

/** Local persisted resource identity is decoded before it reaches a daemon read. */
export const PrPanelData = z.object({
  state: z.optional(z.enum(["open", "draft", "closed", "merged", "unknown"])),
  workspaceId: z.string().check(z.minLength(1)),
  repository: z.optional(
    z.object({
      forge: z.enum(["github", "gitlab"]),
      host: z.string(),
      owner: z.string(),
      name: z.string(),
    }),
  ),
  number: z.number().check(z.int(), z.gte(1)),
});

export function prPanelRepository(data: z.infer<typeof PrPanelData>): string {
  const repository = data.repository;
  return repository ? `${repository.host}/${repository.owner}/${repository.name}` : "";
}

export function prPanelId(data: z.infer<typeof PrPanelData>): string {
  return `${data.workspaceId}/${prPanelRepository(data)}/${data.number}`;
}
