/*
 * Programs the fake shell can run that exercise a real terminal emulator: a full-screen process
 * monitor (`top`) and pager-like editor (`vi`) on the alternate screen with application cursor
 * keys, a colour chart (`colors`) and a burst of log output (`flood`). Pure: each answers the
 * bytes to print, sized to the terminal.
 */

export interface ProgramSize {
  cols: number;
  rows: number;
}

/** A full-screen program's state between keys. */
export interface FullScreen {
  kind: "top" | "vi";
  /** The highlighted row (top) or cursor line (vi). */
  selected: number;
  tick: number;
  /** Bytes of an escape sequence still arriving. */
  pending: string;
}

const esc = "\x1b";
const at = (row: number, col: number) => `${esc}[${row};${col}H`;
const pad = (text: string, width: number) =>
  text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);

const processes = [
  ["412", "bun", "vitest run apps/server"],
  ["388", "node", "apps/daemon/dist/main.js"],
  ["977", "codex", "exec --json"],
  ["120", "zsh", "-l"],
  ["3021", "tsc", "--build --watch"],
  ["77", "git", "fsmonitor--daemon"],
  ["2310", "esbuild", "--service=0.25.0"],
  ["58", "launchd", ""],
];

export function startFullScreen(kind: FullScreen["kind"], size: ProgramSize): [FullScreen, string] {
  const state: FullScreen = { kind, selected: 0, tick: 0, pending: "" };
  // Alternate screen, application cursor keys, hidden cursor for top.
  const enter = `${esc}[?1049h${esc}[?1h${kind === "top" ? `${esc}[?25l` : ""}`;
  return [state, enter + draw(state, size)];
}

/** One typed character: the bytes to print, and whether the program quit. */
export function fullScreenKey(
  state: FullScreen,
  char: string,
  size: ProgramSize,
): { output: string; quit: boolean } {
  if (state.pending || char === esc) {
    state.pending += char;
    const done =
      state.pending.length === 3 &&
      "[O".includes(state.pending[1] ?? "") &&
      "ABCD".includes(state.pending[2] ?? "");
    if (!done && state.pending.length < 3) return { output: "", quit: false };
    const key = state.pending.at(-1);
    state.pending = "";
    if (key === "A") return move(state, -1, size);
    if (key === "B") return move(state, 1, size);
    return { output: "", quit: false };
  }
  if (char === "q") return { output: `${esc}[?25h${esc}[?1l${esc}[?1049l`, quit: true };
  if (char === "j") return move(state, 1, size);
  if (char === "k") return move(state, -1, size);
  state.tick++;
  return { output: draw(state, size), quit: false };
}

/** The program's screen again, for a new size. */
export function redrawFullScreen(state: FullScreen, size: ProgramSize): string {
  return draw(state, size);
}

function move(state: FullScreen, delta: number, size: ProgramSize) {
  const limit = state.kind === "top" ? processes.length : Math.max(1, size.rows - 2);
  state.selected = Math.max(0, Math.min(limit - 1, state.selected + delta));
  state.tick++;
  return { output: draw(state, size), quit: false };
}

function draw(state: FullScreen, size: ProgramSize): string {
  return state.kind === "top" ? drawTop(state, size) : drawVi(state, size);
}

function bar(label: string, fraction: number, width: number): string {
  const inner = Math.max(4, width - label.length - 3);
  const filled = Math.round(inner * fraction);
  const colour = fraction > 0.75 ? 31 : fraction > 0.5 ? 33 : 32;
  return `${esc}[1m${label}${esc}[0m[${esc}[${colour}m${"|".repeat(filled)}${esc}[0m${" ".repeat(inner - filled)}]`;
}

function drawTop(state: FullScreen, size: ProgramSize): string {
  const { cols, rows } = size;
  let out = `${esc}[H${esc}[2J`;
  const half = Math.max(10, Math.floor(cols / 2) - 1);
  for (let cpu = 0; cpu < 4; cpu++) {
    const load = ((cpu * 37 + state.tick * 13) % 100) / 100;
    const row = 1 + Math.floor(cpu / 2);
    const col = cpu % 2 === 0 ? 1 : half + 2;
    out += at(row, col) + bar(`${cpu} `, load, half);
  }
  out += at(3, 1) + bar("Mem", 0.62, cols - 1);
  out +=
    at(4, 1) +
    `Tasks: ${esc}[1m${processes.length}${esc}[0m, ${esc}[32m1 running${esc}[0m  Load: 1.42 1.10 0.98`;
  const header = pad("  PID  CPU%  COMMAND", cols);
  out += at(6, 1) + `${esc}[30;42m${header}${esc}[0m`;
  processes.forEach(([pid = "", name = "", args], index) => {
    const row = 7 + index;
    if (row > rows - 1) return;
    const cpu = (((index + 1) * 7 + state.tick * 3) % 400) / 10;
    const line = pad(`${pid.padStart(5)} ${cpu.toFixed(1).padStart(5)}  ${name} ${args}`, cols);
    out +=
      at(row, 1) +
      (index === state.selected
        ? `${esc}[7m${line}${esc}[0m`
        : `${esc}[36m${line.slice(0, 12)}${esc}[0m${esc}[1m${line.slice(12, 14 + name.length)}${esc}[0m${line.slice(14 + name.length)}`);
  });
  const keys = [
    ["F1", "Help"],
    ["j/k", "Move"],
    ["q", "Quit"],
  ];
  out +=
    at(rows, 1) +
    keys
      .map(([key, label]) => `${esc}[0m${key}${esc}[30;46m${pad(label ?? "", 6)}${esc}[0m`)
      .join("");
  return out;
}

const viText = [
  'import { describe, expect, it } from "vitest";',
  'import { replay } from "./replay.ts";',
  "",
  'describe("replay", () => {',
  '  it("replays only events after lastAckedSeq", () => {',
  "    const events = replay(log, { lastAckedSeq: 3 });",
  "    expect(events.map((e) => e.seq)).toEqual([4, 5]);",
  "  });",
  "});",
];

function drawVi(state: FullScreen, size: ProgramSize): string {
  const { cols, rows } = size;
  let out = `${esc}[H${esc}[2J`;
  for (let row = 1; row < rows; row++) {
    const text = viText[row - 1];
    out += at(row, 1);
    if (text === undefined) out += `${esc}[34m~${esc}[0m`;
    else
      out += text
        .slice(0, cols)
        .replace(/\b(import|from|const|describe|it|expect)\b/g, `${esc}[35m$1${esc}[0m`)
        .replace(/("[^"]*")/g, `${esc}[32m$1${esc}[0m`);
  }
  out +=
    at(rows, 1) +
    `${esc}[7m${pad(` replay.test.ts  ${state.selected + 1},1  All `, cols)}${esc}[0m`;
  out += at(Math.min(rows - 1, state.selected + 1), 1);
  return out;
}

/** The 16 colours, the 256-colour cube, a 24-bit ramp and the text styles. */
export function colourChart(size: ProgramSize): string {
  let out = "";
  for (let base = 0; base < 16; base += 8) {
    for (let index = base; index < base + 8; index++) out += `${esc}[48;5;${index}m  ${esc}[0m`;
    out += "\r\n";
  }
  const perRow = Math.max(6, Math.min(36, Math.floor(size.cols / 2)));
  for (let index = 16; index < 232; index += perRow) {
    for (let cell = index; cell < Math.min(232, index + perRow); cell++)
      out += `${esc}[48;5;${cell}m  ${esc}[0m`;
    out += "\r\n";
  }
  const width = Math.min(size.cols, 60);
  for (let col = 0; col < width; col++) {
    const red = Math.round((255 * col) / width);
    out += `${esc}[48;2;${red};${80};${255 - red}m ${esc}[0m`;
  }
  out += "\r\n";
  out += `${esc}[1mbold${esc}[0m ${esc}[2mfaint${esc}[0m ${esc}[3mitalic${esc}[0m ${esc}[4munderline${esc}[0m `;
  out += `${esc}[7minverse${esc}[0m ${esc}[9mstrike${esc}[0m 漢字 ✓\r\n`;
  return out;
}

/** `count` coloured log lines, in chunks a terminal event may carry. */
export function floodChunks(count: number): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (let index = 1; index <= count; index++) {
    chunk += `${esc}[2m${String(index).padStart(6)}${esc}[0m ${esc}[32mok${esc}[0m compiled packages/ui-core/src/module-${index}.ts in ${index % 97}ms\r\n`;
    if (chunk.length > 32_000) {
      chunks.push(chunk);
      chunk = "";
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
