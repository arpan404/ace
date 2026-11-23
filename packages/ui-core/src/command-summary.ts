const assignment = /^[A-Za-z_][A-Za-z_0-9]*=/;
const shell = /^(?:.*\/)?(?:bash|dash|fish|ksh|sh|zsh)$/;

function shellScript(word: string): string {
  return word.replace(
    /'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)/gs,
    (_, single: string | undefined, double: string | undefined, escaped: string | undefined) =>
      single ?? double?.replace(/\\([$\x60"\\\n])/g, "$1") ?? escaped ?? "",
  );
}

function meaningfulCommand(command: string, depth: number): string {
  // Keep quotes and escapes on display, and split only on unquoted shell separators.
  const tokens = command.match(
    /&&|\|\||[;&|\n]|(?:'[^']*'|"(?:\\.|[^"\\])*"|\\[\s\S]|\$\([^()]*\)|[^\s;&|'"\\])+/g,
  );
  if (!tokens?.length) return command;
  const first = tokens.findIndex((word) => !/^(?:[;&|\n]+|\{|\()$/.test(word));
  if (first < 0) return command;
  const end = tokens.findIndex((word, index) => index > first && /^[;&|\n]+$/.test(word));
  const words = tokens.slice(first, end < 0 ? undefined : end);
  const rest = end < 0 ? [] : tokens.slice(end + 1);
  if (depth > 0) {
    if (
      rest.some((word) => !/^(?:[;&|\n]+|\{|\}|\(|\))$/.test(word)) &&
      (words[0] === "export" || words[0] === "cd" || words.every((word) => assignment.test(word)))
    ) {
      return meaningfulCommand(rest.join(" "), depth - 1);
    }

    let start = 0;
    while (start < words.length - 1) {
      const word = words[start] ?? "";
      if (
        word === "env" ||
        assignment.test(word) ||
        /^(?:~|\$HOME)\/\.local\/bin\/heavy$/.test(word)
      ) {
        start++;
      } else if (word === "nice") {
        start += words[start + 1] === "-n" ? 3 : 1;
      } else break;
    }
    const program = words[start] ?? "";
    if (shell.test(program)) {
      const options = words.slice(start + 1).findIndex((word) => !word.startsWith("-"));
      const flag = words[start + options];
      const script = words[start + options + 1];
      if (options > 0 && flag && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(flag) && script) {
        return meaningfulCommand(shellScript(script), depth - 1);
      }
    }
    if (start > 0 && program) return words.slice(start).join(" ");
  }
  return words.join(" ");
}

/** A one-line shell preview. The original command is kept separately for details. */
export function commandSummary(command: string): string {
  return meaningfulCommand(command.trim(), 8)
    .replace(/[\t\r\n]+/g, " ")
    .trim();
}
