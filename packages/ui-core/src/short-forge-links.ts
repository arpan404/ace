/** A pull request, issue or merge request link on any host: its host, owner, repo and number. */
const forgeLink =
  /https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/(?:-\/)?(?:pull|pulls|issues|merge_requests)\/([1-9][0-9]*)(?:[/?#][^\s]*)?/g;

/**
 * Words with their pull request and issue links shortened to `owner/repo#123`, as a row reads
 * them in one line. Anything else in the text stays as it was.
 */
export function shortForgeLinks(text: string): string {
  return text.replace(forgeLink, "$1/$2#$3");
}
