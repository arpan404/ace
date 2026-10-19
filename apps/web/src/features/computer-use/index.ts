/**
 * Computer use: agents operating apps on this Mac in the background. The Settings page and a
 * thread's panel each load their code on first use, so none of it is in the first paint.
 */
/** The thread workspace's Computer use tab view. */
export const loadComputerUsePanel = () => import("./computer-use-panel.tsx");
/** Settings › Computer use's body (Settings frames it). */
export const loadComputerUseSettings = () =>
  import("./computer-use-page.tsx").then((m) => ({ default: m.ComputerUseSettings }));
