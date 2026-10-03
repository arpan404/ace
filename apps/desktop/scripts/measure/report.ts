import type { Group, Sample } from "./sample.ts";

const mb = (group: Group) => group.mb.toFixed(1);
const columns: [string, (sample: Sample) => string][] = [
  ["main", (s) => mb(s.main)],
  ["renderer", (s) => mb(s.renderer)],
  ["views", (s) => (s.views.count ? `${mb(s.views)} (${s.views.count})` : "-")],
  ["gpu", (s) => mb(s.gpu)],
  ["utility", (s) => `${mb(s.utility)} (${s.utility.count})`],
  ["total", (s) => mb(s.total)],
  ["main heap", (s) => s.mainHeap.toFixed(1)],
  ["renderer heap", (s) => s.rendererHeap?.toFixed(1) ?? "-"],
  [
    "cpu% main/renderer/views/gpu",
    (s) => [s.main, s.renderer, s.views, s.gpu].map((group) => group.cpu.toFixed(1)).join(" / "),
  ],
  [
    "wakeups/s renderer/views",
    (s) => [s.renderer, s.views].map((group) => group.wakeups.toFixed(0)).join(" / "),
  ],
];

/** A plain-text table: resident memory (MB) per process group, CPU (% of one core), wakeups. */
export function table(samples: readonly Sample[]): string {
  const header = ["phase", ...columns.map(([name]) => name)];
  const rows = samples.map((s) => [s.phase, ...columns.map(([, cell]) => cell(s))]);
  const widths = header.map((name, index) =>
    Math.max(name.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ");
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join(
    "\n",
  );
}
