import { join } from "node:path";
import type { DownloadItem, Event as ElectronEvent, Session, WebContents } from "electron";

/** The slice of Electron's save dialog this needs; injected for tests. */
export interface MainDownloadDialog {
  /** The person's chosen path, or undefined when they dismiss the dialog. */
  choosePath(defaultPath: string): Promise<string | undefined>;
}

/**
 * Save the app window's own downloads (attachment previews and the lightbox), which carry
 * `blob:` URLs no other session handles. The person picks the path, defaulting to their
 * downloads folder under the suggested name; dismissing cancels the download.
 */
export function installMainWindowDownloads(options: {
  session: Session;
  /** The app window's page; downloads from anywhere else are left to their own session. */
  contents: WebContents;
  /** The person's downloads folder, for the dialog's default path. */
  downloadsDir: string;
  dialog: MainDownloadDialog;
}): void {
  options.session.on(
    "will-download",
    (_event: ElectronEvent, item: DownloadItem, webContents: WebContents) => {
      if (webContents !== options.contents) return;
      void (async () => {
        const chosen = await options.dialog.choosePath(
          join(options.downloadsDir, item.getFilename() || "download"),
        );
        if (!chosen || options.contents.isDestroyed()) item.cancel();
        else item.setSavePath(chosen);
      })();
    },
  );
}
