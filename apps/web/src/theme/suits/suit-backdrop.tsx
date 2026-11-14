/*
 * Where a Suit's scene draws (ADR 0150): behind the sidebar and the transcript, filling the
 * shell, under every surface. The scene host (a sandboxed iframe on one canvas) renders here;
 * until it lands this draws nothing. While a scene shows, the shell's surfaces over it are
 * glass by ADR 0075's rules, so text keeps the readability floor.
 */
export function SuitBackdrop() {
  return null;
}
