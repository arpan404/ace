import type { FolderSeed } from "../projects.ts";

const day = 86_400_000;

/**
 * A developer's home on the fake host, for the folder browser in dev:fake and the screens:
 * the seeded projects' checkouts sit in it beside a few more repositories, a monorepo package
 * (a subfolder of a repository) and ordinary folders. `now` stamps how recently each changed.
 */
export function hostFolders(now: number): { home: string; folders: FolderSeed[] } {
  const home = "/Users/dev";
  const at = (path: string, ageDays: number, git = false): FolderSeed => ({
    path: `${home}/${path}`,
    git,
    modifiedAt: now - ageDays * day,
  });
  return {
    home,
    folders: [
      at("ace", 0.1, true),
      at("relay", 1, true),
      at("billing-api", 2, true),
      at("Code/design-system", 3, true),
      at("Code/design-system/packages/tokens", 3),
      at("Code/design-system/packages/react", 5),
      at("Code/marketing-site", 9, true),
      at("Code/scratch", 30),
      at("Code/infra-terraform", 41, true),
      at("Documents/notes", 12),
      at("Downloads", 1),
      at("Desktop", 4),
      at(".config", 20),
      at(".ssh", 90),
    ],
  };
}
