export function normalizePaneRatios(ratios: readonly number[], paneCount: number): number[] {
  if (paneCount <= 0) return [];
  if (ratios.length !== paneCount) {
    return Array.from({ length: paneCount }, () => 1 / paneCount);
  }
  const sanitized = ratios.map((ratio) => (Number.isFinite(ratio) && ratio > 0 ? ratio : 0));
  const total = sanitized.reduce((sum, ratio) => sum + ratio, 0);
  if (total <= 0) {
    return Array.from({ length: paneCount }, () => 1 / paneCount);
  }
  return sanitized.map((ratio) => ratio / total);
}

export function resizePaneRatios(options: {
  ratios: readonly number[];
  dividerIndex: number;
  deltaPx: number;
  containerWidthPx: number;
  minPaneWidthPx?: number;
}): number[] {
  const { dividerIndex, deltaPx, containerWidthPx } = options;
  const ratios = normalizePaneRatios(options.ratios, options.ratios.length);
  const left = ratios[dividerIndex];
  const right = ratios[dividerIndex + 1];
  if (left === undefined || right === undefined || containerWidthPx <= 0) {
    return ratios;
  }

  const pairSum = left + right;
  const rawMinRatio = (options.minPaneWidthPx ?? 220) / containerWidthPx;
  const minRatio = Math.min(pairSum / 2, Math.max(rawMinRatio, 0.08));
  const proposedLeft = left + deltaPx / containerWidthPx;
  const nextLeft = Math.min(Math.max(proposedLeft, minRatio), pairSum - minRatio);
  const nextRight = pairSum - nextLeft;
  const next = [...ratios];
  next[dividerIndex] = nextLeft;
  next[dividerIndex + 1] = nextRight;
  return normalizePaneRatios(next, next.length);
}
