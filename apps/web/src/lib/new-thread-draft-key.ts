/**
 * The composer draft key of a new thread on `host`'s `project`, with the skill and the issue or
 * pull request it starts from. New thread reads its draft here; anything giving a message back
 * to New thread (Edit on a failed create) writes it here.
 */
export const newThreadDraftKey = (host: string, project: string, skill?: string, source?: string) =>
  `new:${JSON.stringify(source ? [host, project, skill ?? "", source] : [host, project, skill ?? ""])}`;
