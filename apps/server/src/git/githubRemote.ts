export interface GitHubCloneUrls {
  readonly url: string;
  readonly sshUrl: string;
}

export function parseGitHubRepositoryNameWithOwnerFromRemoteUrl(
  url: string | null | undefined,
): string | null {
  const trimmed = url?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }

  const match =
    /^(?:(?:git@|ssh:\/\/git@)(?:ssh\.)?github\.com(?::\d+)?[:/]|https:\/\/github\.com\/|git:\/\/github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(
      trimmed,
    );
  const repositoryNameWithOwner = match?.[1]?.trim() ?? "";
  return repositoryNameWithOwner.length > 0 ? repositoryNameWithOwner : null;
}

export function shouldPreferSshRemote(url: string | null | undefined): boolean {
  const trimmed = url?.trim() ?? "";
  return (
    trimmed.startsWith("git@") ||
    trimmed.startsWith("ssh://") ||
    trimmed.startsWith("ssh.github.com:")
  );
}

export function selectPreferredGitHubCloneUrl(input: {
  readonly currentRemoteUrl: string | null | undefined;
  readonly cloneUrls: GitHubCloneUrls;
}): string {
  return shouldPreferSshRemote(input.currentRemoteUrl)
    ? input.cloneUrls.sshUrl
    : input.cloneUrls.url;
}
