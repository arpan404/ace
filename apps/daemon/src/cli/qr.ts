import createQr from "qrcode-generator";
export function terminalQr(value: string): string {
  const qr = createQr(0, "M");
  qr.addData(value);
  qr.make();
  const size = qr.getModuleCount();
  const dark = (row: number, col: number) =>
    row >= 0 && col >= 0 && row < size && col < size && qr.isDark(row, col);
  const lines: string[] = [];
  for (let row = -4; row < size + 4; row += 2) {
    let line = "";
    for (let col = -4; col < size + 4; col++) {
      const top = dark(row, col);
      const bottom = dark(row + 1, col);
      // Explicit black on white preserves the quiet zone in dark terminals.
      line += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
    }
    lines.push(`\u001b[30;47m${line}\u001b[0m`);
  }
  return lines.join("\n") + "\n";
}
