import type { DiffPanelMode } from "./DiffPanelShell";

const DIFF_PANEL_SHARED_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-bg: color-mix(in srgb, var(--background) 98%, var(--foreground)) !important;
  --diffs-light-bg: color-mix(in srgb, var(--background) 98%, var(--foreground)) !important;
  --diffs-dark-bg: color-mix(in srgb, var(--background) 98%, var(--foreground)) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  --diffs-bg-context-override: color-mix(in srgb, var(--background) 97%, var(--foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 95%, var(--foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--background) 90%, var(--foreground));

  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 92%, var(--success));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 88%, var(--success));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--background) 85%, var(--success));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--success));

  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 92%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--background) 88%, var(--destructive));
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--background) 85%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(
    in srgb,
    var(--background) 80%,
    var(--destructive)
  );

  background-color: var(--diffs-bg) !important;
}

[data-diff],
[data-file],
[data-error-wrapper] {
  border-radius: 0 !important;
  box-shadow: none !important;
}

[data-file] {
  border-bottom: 1px solid color-mix(in srgb, var(--border) 76%, transparent) !important;
}

[data-file]:last-child {
  border-bottom: none !important;
}

[data-file-info] {
  background-color: color-mix(in srgb, var(--background) 95%, var(--foreground)) !important;
  border-block-color: var(--border) !important;
  color: var(--foreground) !important;
}

[data-title] {
  cursor: pointer;
  transition:
    color 120ms ease,
    text-decoration-color 120ms ease;
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 2px;
}

[data-title]:hover {
  color: color-mix(in srgb, var(--foreground) 84%, var(--primary)) !important;
  text-decoration-color: currentColor;
}
`;

function getDiffHeaderUnsafeCss(mode: DiffPanelMode): string {
  if (mode === "sidebar") {
    return `
[data-diffs-header] {
  position: relative !important;
  top: auto !important;
  z-index: 1 !important;
  background-color: color-mix(in srgb, var(--background) 95%, var(--foreground)) !important;
  border-bottom: 1px solid var(--border) !important;
}
`;
  }

  return `
[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  background-color: color-mix(in srgb, var(--background) 95%, var(--foreground)) !important;
  border-bottom: 1px solid var(--border) !important;
}
`;
}

export function buildDiffPanelUnsafeCss(mode: DiffPanelMode): string {
  return `${DIFF_PANEL_SHARED_UNSAFE_CSS}\n${getDiffHeaderUnsafeCss(mode)}`;
}
