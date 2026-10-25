/*
 * Short, app-specific advice shown the first time a caller looks at an app: which action
 * works, and the traps that make an obvious one fail. Written for ace from its own testing.
 */
const browser =
  "Browser: for web pages use browser_open and the browser_* tools, which read and act on the page directly; use this only for the browser's own windows and settings.";
const electron = (name: string) =>
  `${name}: an Electron app. Its accessibility tree can take a moment to load; if the outline is nearly empty, observe again or try a screenshot. Activating it would interrupt the person.`;

const notes: ReadonlyMap<string, string> = new Map([
  ["com.apple.safari", browser],
  ["com.google.chrome", browser],
  ["company.thebrowser.browser", browser],
  ["org.mozilla.firefox", browser],
  ["com.microsoft.edgemac", browser],
  ["com.brave.browser", browser],
  [
    "com.microsoft.vscode",
    `${electron("VS Code")} For code, edit files with your own tools instead.`,
  ],
  ["com.hnc.discord", `${electron("Discord")} Return sends the message being typed.`],
  [
    "com.apple.dt.xcode",
    'Xcode: build and run with menu ["Product", "Run"] or the shell (xcodebuild); edit source files with your own tools, not by typing into the editor.',
  ],
  [
    "com.apple.iwork.pages",
    "Pages: the document body is one text area; paste with format markdown keeps headings and lists.",
  ],
  [
    "com.apple.iwork.numbers",
    "Numbers: select a cell by clicking it, then type and press Return or Tab; formulas start with =.",
  ],
  [
    "com.apple.iwork.keynote",
    "Keynote: pick a slide in the navigator, then click a text box on it before typing.",
  ],
  [
    "com.apple.preview",
    "Preview: a document's text is often only in the screenshot; for PDFs, reading the file with your own tools is faster.",
  ],
  [
    "com.tinyspeck.slackmacgap",
    "Slack: Return sends the message being typed. For multi-line text use set_value on the message field, or key shift+Return between lines. The outline can lag behind new messages; observe again to confirm what was sent.",
  ],
  [
    "com.apple.mobilesms",
    "Messages: Return sends. Check the recipient in the outline before typing, and confirm with the person before sending anything they did not dictate.",
  ],
  [
    "com.apple.mail",
    'Mail: compose with menu ["File", "New Message"]; fill To, Subject and body with set_value. Sending is irreversible; confirm with the person first.',
  ],
  [
    "com.apple.finder",
    "Finder: double-click (count 2) opens an item; prefer the shell for file operations, which is faster and exact.",
  ],
  [
    "com.apple.notes",
    'Notes: the note body is one text area; select_text with cursor "after" places the caret, then type. A note\'s first line is its title.',
  ],
  [
    "com.apple.calculator",
    'Calculator: type the whole expression, e.g. type "12*34="; the display is the text element under "Edit field".',
  ],
  [
    "com.apple.systempreferences",
    "System Settings: panes load lazily; after choosing a sidebar row, observe again before acting. Changing settings affects the whole Mac; confirm with the person first.",
  ],
]);

export function appNote(bundleId: string): string | undefined {
  return notes.get(bundleId.toLowerCase());
}
