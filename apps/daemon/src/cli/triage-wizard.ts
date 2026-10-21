import { createInterface } from "node:readline";
import { CliFailure } from "./output.ts";

/** One readline owner, closed before the provider takes over stdin. */
export function triageWizard() {
  const lines = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const input = lines[Symbol.asyncIterator]();
  const next = async () => {
    const line = await input.next();
    if (line.done) throw new CliFailure("needs-human", "Triage cancelled.");
    return line.value;
  };
  return {
    async choose<T extends string>(
      label: string,
      choices: readonly { value: T; label: string }[],
    ): Promise<T> {
      for (;;) {
        process.stderr.write(
          `\n${label}\n${choices.map((choice, index) => `  ${index + 1}. ${choice.label}`).join("\n")}\n> `,
        );
        const value = (await next()).trim();
        const choice = choices.find(
          (item, index) => value === String(index + 1) || value === item.value,
        );
        if (choice) return choice.value;
        process.stderr.write("Choose one of the listed numbers.\n");
      }
    },
    async describe(): Promise<string> {
      process.stderr.write(
        "\nDescribe what you need. End with a line containing only a dot (.).\n",
      );
      const result: string[] = [];
      let length = 0;
      for (;;) {
        const line = await next();
        if (line === ".") {
          if (result.join("\n").trim()) return result.join("\n");
          process.stderr.write("Enter a description first.\n");
          continue;
        }
        length += line.length + 1;
        if (length > 16_000)
          throw new CliFailure("refused", "Description exceeds 16,000 characters.");
        result.push(line);
      }
    },
    close() {
      lines.close();
      process.stdin.pause();
    },
  };
}
