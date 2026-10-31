import type { ThreadListEntry } from "@ace/protocol";

/**
 * Whether a listed thread matches what the person typed in the Threads panel's search: every
 * word must appear, case aside, in its title, its project's name, its branch or a linked pull
 * request's number ("#1536" or "1536"). An empty query matches everything.
 */
export function threadMatches(
  entry: Pick<ThreadListEntry, "title" | "details">,
  query: string,
  projectName: string,
): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const details = entry.details;
  const prs = [
    ...(details?.linkedPrs?.map((pr) => pr.number) ?? []),
    ...(details?.linkedPr ? [details.linkedPr.number] : []),
  ];
  const haystack = [
    entry.title,
    projectName,
    details?.branch ?? "",
    ...prs.map((number) => `#${number}`),
  ]
    .join("\n")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}
