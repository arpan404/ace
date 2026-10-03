import { expect, test } from "vitest";
import { TerminalScreen } from "./screen.ts";

const screenOf = (...chunks: string[]) => {
  const screen = new TerminalScreen();
  for (const chunk of chunks) screen.write(chunk);
  return screen;
};

test("a progress bar redrawn with carriage returns leaves only its last state", () => {
  expect(screenOf("building 10%\rbuilding 55%\rbuilding 100%\r\ndone\r\n").text()).toBe(
    "building 100%\ndone",
  );
});

test("backspace echo erases the typed character", () => {
  expect(screenOf("$ gti", "\b \b\b \b", "it status").text()).toBe("$ git status");
});

test("an escape sequence split across two chunks still colours the text", () => {
  const screen = screenOf("\x1b[3", "2mpass\x1b[0m ok");
  const [row] = screen.rows();
  expect(row?.segments).toEqual([
    { text: "pass", style: { tone: "green" } },
    { text: " ok", style: {} },
  ]);
});

test("clear screen drops earlier output and keeps what follows", () => {
  expect(screenOf("old output\r\n$ clear\r\n", "\x1b[2J\x1b[H", "$ ").text()).toBe("$ ");
});

test("erase to end of line removes the rest of a rewritten line", () => {
  expect(screenOf("downloading packages\r\x1b[Kdone").text()).toBe("done");
});

test("title-setting sequences are not printed", () => {
  expect(screenOf("\x1b]0;~/ace\x07$ ls").text()).toBe("$ ls");
});

test("scrollback is bounded", () => {
  const screen = new TerminalScreen({ scrollback: 3 });
  screen.write("1\r\n2\r\n3\r\n4\r\n5");
  expect(screen.text()).toBe("3\n4\n5");
});

const rowText = (screen: TerminalScreen) =>
  screen.rows().map((row) => row.segments.map((segment) => segment.text).join(""));

test("a row redrawn after it was shown shows its new text, and the rows above keep theirs", () => {
  const screen = screenOf("$ bun run build\r\n", "building 10%");
  const [command, progress] = screen.rows();
  expect(rowText(screen)).toEqual(["$ bun run build", "building 10%"]);

  screen.write("\rbuilding 55%\x1b[K");
  expect(rowText(screen)).toEqual(["$ bun run build", "building 55%"]);
  // Output only touched the progress line; the command line is the row already drawn.
  expect(screen.rows()[0]).toBe(command);
  expect(screen.rows()[1]).not.toBe(progress);

  screen.write("\x1b[1A\r$ bun run test\x1b[K");
  expect(rowText(screen)).toEqual(["$ bun run test", "building 55%"]);
});
