import type { WebContents } from "electron";
/** Native find reports counts without replacing the page's document or input surface. */
export function findNativeText(
  contents: WebContents,
  text: string,
  forward: boolean,
): Promise<{ matches: number; active?: number }> {
  if (!text) {
    contents.stopFindInPage("clearSelection");
    return Promise.resolve({ matches: 0 });
  }
  return new Promise((resolve, reject) => {
    let requestId: number | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      contents.off("found-in-page", found);
      contents.off("destroyed", destroyed);
    };
    const destroyed = () => {
      cleanup();
      reject(new Error("Browser view closed"));
    };
    const found = (_event: unknown, result: Electron.Result) => {
      if (!result.finalUpdate || (requestId !== undefined && result.requestId !== requestId))
        return;
      cleanup();
      resolve({ matches: result.matches, active: result.activeMatchOrdinal });
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Find timed out"));
    }, 10000);
    contents.on("found-in-page", found);
    contents.once("destroyed", destroyed);
    try {
      requestId = contents.findInPage(text, { forward });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
