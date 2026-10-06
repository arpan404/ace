import { unwrapShellCommand } from "@ace/provider-kit/shell-command";

export interface InspectionCommand {
  executable: string;
  paths: string[];
  regularFiles: boolean;
}
/** An intentionally small grammar. No expansion, globs, redirects, execution or recursive reads. */
export function inspectionCommand(command: string): InspectionCommand | undefined {
  const script = unwrapShellCommand(command)?.inner ?? command;
  if (!/^[\w./ -]+$/.test(script) || /(?:^|\s)\.\.(?:\/|$)/.test(script)) return undefined;
  const words = script.trim().split(/\s+/);
  const executable = words.shift() ?? "";
  if (executable === "pwd" && !words.length) return { executable, paths: [], regularFiles: false };
  if (executable === "ls") {
    const paths: string[] = [];
    for (const word of words) {
      if (/^-[alh1]+$/.test(word) || word === "--") continue;
      if (word.startsWith("-")) return undefined;
      paths.push(word);
    }
    return { executable, paths: paths.length ? paths : ["."], regularFiles: false };
  }
  if (!["cat", "head", "tail", "wc"].includes(executable)) return undefined;
  const paths: string[] = [];
  let options = true;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!word) return undefined;
    if (options && word === "--") {
      options = false;
      continue;
    }
    if (options && word.startsWith("-")) {
      if (
        ["head", "tail"].includes(executable) &&
        word === "-n" &&
        /^\d+$/.test(words[i + 1] ?? "")
      ) {
        i++;
        continue;
      }
      if (executable === "wc" && /^-[lcwm]+$/.test(word)) continue;
      if (executable === "cat" && /^-[nbEsTv]+$/.test(word)) continue;
      return undefined;
    }
    if (word === "-" || word.startsWith("-")) return undefined;
    paths.push(word);
  }
  return paths.length ? { executable, paths, regularFiles: true } : undefined;
}
