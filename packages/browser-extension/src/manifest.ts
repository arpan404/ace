import { extensionPublicKey } from "./extension-id.ts";

export const extensionVersion = "0.1.0";

/** ace for Chrome's MV3 manifest (ADR 0084). `debugger` drives tabs; nothing reads cookies. */
export function extensionManifest() {
  return {
    manifest_version: 3,
    name: "ace for Chrome",
    version: extensionVersion,
    description: "Lets ace agents work in tabs you share with them.",
    key: extensionPublicKey,
    minimum_chrome_version: "125",
    permissions: ["debugger", "nativeMessaging", "tabs", "tabGroups", "storage"],
    background: { service_worker: "background.js" },
    action: { default_popup: "popup.html", default_title: "ace" },
    options_ui: { page: "popup.html", open_in_tab: false },
  };
}
