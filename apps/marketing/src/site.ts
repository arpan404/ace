/** Where the site's links point. One place, so a moved repository is one edit. */
export const repository = "arpan404/ace";

const github = `https://github.com/${repository}`;

export const links = {
  source: github,
  releases: `${github}/releases`,
  latestRelease: `${github}/releases/latest`,
  license: `${github}/blob/main/LICENSE`,
} as const;
