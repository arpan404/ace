import { sensitiveApp } from "@ace/screen/sensitive-app";

/*
 * What people call a macOS app, from its bundle id. Computer-use approvals, grants and live
 * sessions name apps by bundle id on the wire; people know "TextEdit", not "com.apple.TextEdit".
 */

const known: Record<string, string> = {
  "com.apple.textedit": "TextEdit",
  "com.apple.calculator": "Calculator",
  "com.apple.iphonesimulator": "Simulator",
  "com.apple.safari": "Safari",
  "com.apple.finder": "Finder",
  "com.apple.notes": "Notes",
  "com.apple.mail": "Mail",
  "com.apple.preview": "Preview",
  "com.apple.systempreferences": "System Settings",
  "com.apple.keychainaccess": "Keychain Access",
  "com.apple.terminal": "Terminal",
  "com.apple.dt.xcode": "Xcode",
  "com.googlecode.iterm2": "iTerm",
  "com.google.chrome": "Chrome",
  "com.microsoft.vscode": "VS Code",
  "com.figma.desktop": "Figma",
  "com.tinyspeck.slackmacgap": "Slack",
  "com.1password.1password": "1Password",
};

/** "TextEdit" for `com.apple.TextEdit`; an unknown id reads as its last segment, spaced. */
export function appName(bundleId: string): string {
  const name = known[bundleId.toLowerCase()];
  if (name) return name;
  const last = bundleId.split(".").filter(Boolean).at(-1) ?? bundleId;
  const spaced = last
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : bundleId;
}

/**
 * Apps the daemon always asks about, even with a saved grant (password managers, System
 * Settings, Keychain Access, terminals, ace itself). The same rule the daemon applies.
 */
export function alwaysAsks(bundleId: string): boolean {
  return sensitiveApp(bundleId);
}
