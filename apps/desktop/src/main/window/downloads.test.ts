import { describe, expect, it, vi } from "vitest";
import type { DownloadItem, Session, WebContents } from "electron";
import { installMainWindowDownloads } from "./downloads.ts";

function setup(downloadsDir = "/Users/me/Downloads") {
  const listeners = new Map<string, (...args: never[]) => void>();
  const session = {
    on: vi.fn((event: string, listener: (...args: never[]) => void) => {
      listeners.set(event, listener);
    }),
  } as unknown as Session;
  let destroyed = false;
  const contents = { isDestroyed: () => destroyed } as WebContents;
  const dialog = {
    choosePath: vi.fn(async (): Promise<string | undefined> => "/Users/me/Downloads/home.png"),
  };
  installMainWindowDownloads({ session, contents, downloadsDir, dialog });
  const item = {
    getFilename: () => "home.png",
    setSavePath: vi.fn(),
    cancel: vi.fn(),
  } as unknown as DownloadItem;
  const fire = (webContents: WebContents) =>
    listeners.get("will-download")?.({} as never, item as never, webContents as never);
  return { session, contents, dialog, item, fire, destroy: () => (destroyed = true) };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("app window downloads", () => {
  it("saves under the suggested name in the person's downloads folder", async () => {
    const f = setup();
    f.fire(f.contents);
    await flush();
    expect(f.dialog.choosePath).toHaveBeenCalledWith("/Users/me/Downloads/home.png");
    expect(f.item.setSavePath).toHaveBeenCalledWith("/Users/me/Downloads/home.png");
    expect(f.item.cancel).not.toHaveBeenCalled();
  });

  it("cancels when the person dismisses the save dialog", async () => {
    const f = setup();
    f.dialog.choosePath.mockResolvedValueOnce(undefined);
    f.fire(f.contents);
    await flush();
    expect(f.item.cancel).toHaveBeenCalledTimes(1);
    expect(f.item.setSavePath).not.toHaveBeenCalled();
  });

  it("leaves other pages' downloads to their own session", async () => {
    const f = setup();
    f.fire({ isDestroyed: () => false } as WebContents);
    await flush();
    expect(f.dialog.choosePath).not.toHaveBeenCalled();
    expect(f.item.cancel).not.toHaveBeenCalled();
    expect(f.item.setSavePath).not.toHaveBeenCalled();
  });

  it("cancels when the window closes during the dialog", async () => {
    const f = setup();
    f.dialog.choosePath.mockImplementationOnce(async () => {
      f.destroy();
      return "/Users/me/Downloads/home.png";
    });
    f.fire(f.contents);
    await flush();
    expect(f.item.cancel).toHaveBeenCalledTimes(1);
    expect(f.item.setSavePath).not.toHaveBeenCalled();
  });
});
