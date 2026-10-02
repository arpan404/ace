import { hash } from "./decode.ts";
import { textOutput } from "./cli.ts";
import { BlobClassifier } from "./blob-classifier.ts";
import type { DiffFile } from "./parse-diff.ts";
import type { Repository } from "./repository.ts";
import { withIndex } from "./temporary-index.ts";

export async function classifyBinaries(
  repository: Repository,
  root: string,
  files: DiffFile[],
): Promise<void> {
  const hashes = new Set<string>();
  for (const file of files) {
    if (file.oldMode !== "160000" && !/^0+$/.test(file.oldSha)) hashes.add(file.oldSha);
    if (file.newMode !== "160000" && !/^0+$/.test(file.newSha)) hashes.add(file.newSha);
  }
  const wanted = [...hashes];
  if (!wanted.length) return;
  const classifier = new BlobClassifier(wanted);
  await repository.cli.call(root, ["cat-file", "--batch"], {
    input: wanted.join("\n") + "\n",
    consume: (chunk) => classifier.feed(chunk),
  });
  const binary = classifier.finish();
  for (const { entry, oldSha, newSha } of files) {
    if (binary.has(oldSha) || binary.has(newSha)) entry.binary = true;
    if (entry.binary) {
      entry.additions = 0;
      entry.deletions = 0;
    }
  }
}
export async function textTrees(
  repository: Repository,
  root: string,
  files: DiffFile[],
): Promise<[string, string]> {
  const oldEntries = new Map<string, string>();
  const newEntries = new Map<string, string>();
  for (const file of files) {
    if (file.entry.binary) continue;
    if (file.oldMode !== "000000") {
      const path = file.entry.oldPath ?? file.entry.path;
      oldEntries.set(path, `${file.oldMode} ${file.oldSha} 0\t${path}\0`);
    }
    if (file.newMode !== "000000")
      newEntries.set(file.entry.path, `${file.newMode} ${file.newSha} 0\t${file.entry.path}\0`);
  }
  const write = (entries: Map<string, string>) =>
    withIndex(repository.tempDirectory, async (env) => {
      await repository.cli.call(root, ["read-tree", "--empty"], { write: true, env });
      await repository.cli.call(root, ["update-index", "-z", "--index-info"], {
        write: true,
        env,
        input: [...entries.values()].join(""),
      });
      return hash(
        textOutput(await repository.cli.call(root, ["write-tree"], { write: true, env })),
      );
    });
  return [await write(oldEntries), await write(newEntries)];
}
export function binaryNotices(files: DiffFile[]): string {
  return files
    .filter((file) => file.entry.binary)
    .map(({ entry }) => {
      const from = entry.status === "A" ? "/dev/null" : `a/${entry.oldPath ?? entry.path}`;
      const to = entry.status === "D" ? "/dev/null" : `b/${entry.path}`;
      return `diff --git ${JSON.stringify(`a/${entry.oldPath ?? entry.path}`)} ${JSON.stringify(`b/${entry.path}`)}\nBinary files ${JSON.stringify(from)} and ${JSON.stringify(to)} differ\n`;
    })
    .join("");
}
