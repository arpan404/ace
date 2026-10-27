/*
 * KaTeX with the safety settings agent prose requires: no hyperlinks or HTML
 * commands (`trust: false`) and no red error output. Untrusted commands
 * (`\href`, `\url`) render red rather than throwing, so those fall back too.
 * Shared by the web's main thread and markdown worker and the phone's math page; each
 * passes its own `renderToString` in, so none imports another's module (the worker
 * must not pull in KaTeX's CSS).
 */

export type TexRenderer = (
  tex: string,
  options: { displayMode: boolean; throwOnError: boolean; trust: boolean; strict: boolean },
) => string;

/**
 * `tex` as HTML, or `undefined` when it is not safe to show rendered: invalid
 * TeX throws and is shown as source instead. Never a red error box.
 */
export function renderTex(
  render: TexRenderer,
  tex: string,
  displayMode: boolean,
): string | undefined {
  let html: string;
  try {
    html = render(tex, { displayMode, throwOnError: true, trust: false, strict: false });
  } catch {
    return undefined;
  }
  if (html.includes("katex-error") || html.includes("#cc0000")) return undefined;
  return html;
}
