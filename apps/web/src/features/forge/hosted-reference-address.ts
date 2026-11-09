import { prUrl } from "@ace/forge/pr-reference";
import type { ForgeRepository } from "@ace/protocol";

const segment = /^(?!\.{1,2}$)[\w.-]+$/;
const handle = /^[\w.-]+$/;
const sameRepository = (repository: ForgeRepository, owner: string, name: string) =>
  repository.owner.toLowerCase() === owner.toLowerCase() &&
  repository.name.toLowerCase() === name.toLowerCase();

/**
 * Where a reference in review text read from Cursor Origin or GitLab points, as that host links
 * it. On Cursor Origin `#12` is review 12 of the same repository, which ace opens as its page.
 * On GitLab `#12` is an issue (merge requests are `!12`), so it opens on GitLab. Mentions and
 * commits link to the host only where its addresses are known. Undefined when the reference
 * names another repository or isn't one of these.
 */
export function hostedReferenceAddress(
  reference: { kind: string; target: string },
  repository: ForgeRepository,
): string | undefined {
  const { kind, target } = reference;
  const base = `https://${repository.host}/${repository.owner}/${repository.name}`;
  if (kind === "issue") {
    const match = /^(?:([\w./-]+)\/([\w.-]+))?#([1-9]\d*)$/.exec(target);
    if (!match) return undefined;
    const [, owner, name, number] = match;
    if (owner && name && !sameRepository(repository, owner, name)) return undefined;
    if (repository.forge === "gitlab") return `${base}/-/issues/${number}`;
    try {
      return prUrl({ repository, number: Number(number) });
    } catch {
      return undefined;
    }
  }
  if (repository.forge !== "gitlab") return undefined;
  if (kind === "commit")
    return /^[0-9a-f]{7,40}$/i.test(target) ? `${base}/-/commit/${target}` : undefined;
  if (kind === "mention")
    return handle.test(target) && segment.test(target)
      ? `https://${repository.host}/${target}`
      : undefined;
  return undefined;
}
