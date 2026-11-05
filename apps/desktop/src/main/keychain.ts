/**
 * The name Chromium files this app's macOS keychain item under: `"<name> Safe Storage"`,
 * account `"<name> Key"`. The older ace 0.x app (`com.ace.ace`, also named "ace") owns
 * "ace Safe Storage"; reading that item from this app's signature asks for the login password,
 * so this app never uses it.
 */
export const keychainName = "ace desktop";

/** The slice of Electron's `app` that `claimKeychainName` uses; injected for tests. */
export interface NamedApp {
  getName(): string;
  setName(name: string): void;
  getPath(name: "userData"): string;
  setPath(name: "userData", path: string): void;
  whenReady(): Promise<unknown>;
}

/**
 * Starts Chromium under `keychainName` and gives the app its own name back once it is ready.
 *
 * Electron reads the app name for the keychain item once, after the main script's first run
 * and before `ready`, so it must be set synchronously at the top of the main script. The data
 * folder is pinned first, since its default follows the name; menus, the About panel and logs
 * read the name later and get the real one.
 *
 * Nothing in the app needs the keychain today (cookie encryption is off and `safeStorage` is
 * unused), so this only guarantees that a future use can never read the legacy app's item.
 */
export function claimKeychainName(app: NamedApp, platform: NodeJS.Platform): void {
  if (platform !== "darwin") return;
  const name = app.getName();
  app.setPath("userData", app.getPath("userData"));
  app.setName(keychainName);
  void app.whenReady().then(() => app.setName(name));
}
