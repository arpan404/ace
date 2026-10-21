import { z } from "zod";
import { useState } from "react";
import { desktopBrowserViews } from "@/boot/desktop-browser.ts";
import { revealer } from "@/boot/open-external.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { copyImageToClipboard } from "@/lib/clipboard-image.ts";
import type { BrowserTabView, BrowserView, PreviewSource } from "../sources.ts";
import { reason } from "./use-browser-features.ts";

const Saved = z.object({ path: z.string(), data: z.string().optional() });
export const PageSource = z.object({
  url: z.string(),
  source: z.string(),
  truncated: z.boolean(),
});
export type PageSource = z.infer<typeof PageSource>;

const pngBlob = (data: string) =>
  new Blob([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))], { type: "image/png" });

/**
 * The page commands of the ⋯ menu and the right-click menu, on whichever engine shows the
 * page: the desktop's native view prints and opens developer tools itself; ace's Chrome
 * prints to a PDF kept with the thread. Screenshots, page source and clearing data go through
 * the daemon either way.
 */
export function usePageActions(input: {
  source: PreviewSource;
  threadId: string;
  live: BrowserView | undefined;
  tab: BrowserTabView | undefined;
  /** The desktop's native view shows the page now. */
  nativeShown: boolean;
}) {
  const { source, threadId, live, tab } = input;
  const toast = useToast();
  const [pageSource, setPageSource] = useState<PageSource>();
  const tabId = tab?.tabId;
  const native =
    input.nativeShown && live?.backend === "embedded" ? desktopBrowserViews() : undefined;
  const reveal = revealer();
  const savedToast = (title: string, path: string) =>
    toast.add({
      title,
      ...(reveal
        ? {
            actionProps: {
              children: "Show in Finder",
              onClick: () => void reveal(path).catch(() => {}),
            },
          }
        : {}),
    });
  const run = async (title: string, work: () => Promise<unknown>) => {
    try {
      return await work();
    } catch (error) {
      toast.error({ title, description: reason(error) });
      return undefined;
    }
  };
  const tool = source.pageTool;
  const available = !!live && !!tab && !!tool && live.backend !== "user";

  const printPdf = async () => {
    if (!tool) return;
    const saved = Saved.safeParse(
      await run("Couldn't print the page", () =>
        tool(threadId, { action: "pdf", landscape: false, printBackground: true }, tabId),
      ),
    );
    if (saved.success) savedToast("PDF saved to this thread", saved.data.path);
  };

  return {
    /** Print, Screenshot, Page source and Clear data work here. */
    available,
    /** Developer tools open only for the desktop's own view of the page. */
    devtoolsReason: native
      ? undefined
      : "Developer tools open for pages shown in the desktop app's own browser",
    print() {
      if (native)
        void native.page(threadId, "print").then((done) => {
          if (!done) void printPdf();
        });
      else void printPdf();
    },
    devtools(at?: { x: number; y: number }) {
      void native?.page(threadId, "devtools", at);
    },
    screenshot(fullPage: boolean) {
      if (!tool) return;
      void (async () => {
        const shot = Saved.safeParse(
          await run("Couldn't take a screenshot", () =>
            tool(threadId, { action: "screenshot", fullPage }, tabId),
          ),
        );
        if (!shot.success) return;
        const { data, path } = shot.data;
        if (data) {
          const copied = await copyImageToClipboard(Promise.resolve(pngBlob(data))).then(
            () => true,
            () => false,
          );
          savedToast(
            copied
              ? "Screenshot copied and saved to this thread"
              : "Screenshot saved to this thread",
            path,
          );
        } else savedToast("Screenshot saved to this thread", path);
      })();
    },
    viewSource() {
      if (!tool) return;
      void run("Couldn't read the page source", async () => {
        setPageSource(PageSource.parse(await tool(threadId, { action: "page_source" }, tabId)));
      });
    },
    pageSource,
    closeSource: () => setPageSource(undefined),
    async clearData(): Promise<boolean> {
      if (!tool) return false;
      const done = await run("Couldn't clear browsing data", () =>
        tool(threadId, { action: "clear_data" }, tabId),
      );
      return done !== undefined;
    },
  };
}

export type PageActions = ReturnType<typeof usePageActions>;
