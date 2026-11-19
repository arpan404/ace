/** The repository forge text was written in: where `#12` and a bare commit hash point. */
export interface ReferenceRepository {
  host: string;
  owner: string;
  name: string;
}

/** An owner or repository name; never `.` or `..`, which would leave the repository. */
const segment = /^(?!\.{1,2}$)[\w.-]+$/;
/** A GitHub login or team slug. */
const handle = /^[\w-]+$/;

/**
 * The page a forge reference in PR or issue text points at, as GitHub links it: `#12` and
 * `owner/repo#12` to the issue (GitHub forwards a pull request's number to it), `@login` to the
 * person, `@org/team` to the team, and a commit hash (or `owner/repo@sha`) to the commit.
 * Undefined when the reference needs a repository and there is none, or isn't one of these.
 */
export function forgeReferenceAddress(
  reference: { kind: string; target: string },
  repository: ReferenceRepository | undefined,
): string | undefined {
  const host = repository?.host ?? "github.com";
  const { kind, target } = reference;
  const at = (owner: string | undefined, name: string | undefined, rest: string) =>
    owner && name && segment.test(owner) && segment.test(name)
      ? `https://${host}/${owner}/${name}/${rest}`
      : undefined;
  if (kind === "issue") {
    const match = /^(?:([\w.-]+)\/([\w.-]+))?#(\d+)$/.exec(target);
    if (!match) return undefined;
    const [, owner, name, number] = match;
    return owner
      ? at(owner, name, `issues/${number}`)
      : at(repository?.owner, repository?.name, `issues/${number}`);
  }
  if (kind === "commit") {
    const match = /^(?:([\w.-]+)\/([\w.-]+)@)?([0-9a-f]{7,40})$/i.exec(target);
    if (!match) return undefined;
    const [, owner, name, sha] = match;
    return owner
      ? at(owner, name, `commit/${sha}`)
      : at(repository?.owner, repository?.name, `commit/${sha}`);
  }
  if (kind === "mention") {
    const [login, team, extra] = target.split("/");
    if (!login || !handle.test(login) || extra !== undefined) return undefined;
    if (team === undefined) return `https://${host}/${login}`;
    return handle.test(team) ? `https://${host}/orgs/${login}/teams/${team}` : undefined;
  }
  return undefined;
}
