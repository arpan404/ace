/*
 * The workspace's lazily loaded views. They live here, not in `index.ts`, so the index stays a
 * pure list of re-exports: an index with code of its own is a real module, and the bundler then
 * loads every module it re-exports with it, into the first paint.
 */
import { deferredComponent } from "@/lib/deferred-component.tsx";

export const loadCreateFile = () => import("./files/create-file.tsx");
/** A provider's sign-in terminal, outside any thread (the app hands it to the sign-in dialog). */
export const loadAuthTerminal = () => import("./terminal/auth-terminal.tsx");

export const loadThreadBrowser = () => import("./browser/thread-browser.tsx");
/** Every thread's page floating in picture-in-picture, over whatever screen shows. */
export const loadFloatingBrowsers = () => import("./browser/floating-browsers.tsx");

/**
 * Shared, bounded diff rendering for hosted and local changes. Its code loads with the view that
 * shows a diff: imported statically it would join the first paint, which never draws one.
 */
export const DeferredFileDiffBlock = deferredComponent(() =>
  import("./changes/file-diff.tsx").then((module) => module.FileDiffBlock),
);
export const DeferredFileTree = deferredComponent(() =>
  import("./changes/file-tree.tsx").then((module) => module.FileTree),
);
