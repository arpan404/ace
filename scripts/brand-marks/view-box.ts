/** Leave a half-unit margin for catalog paths that extend just beyond the nominal box. */
export function paddedViewBox(viewBox: string): string {
  const [x = 0, y = 0, width = 24, height = 24] = viewBox.split(" ").map(Number);
  const pad = Math.max(width, height) / 48;
  return `${x - pad} ${y - pad} ${width + pad * 2} ${height + pad * 2}`;
}
