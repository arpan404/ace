/*
 * Short, app-specific advice shown the first time a caller looks at an app: which action
 * works, and the traps that make an obvious one fail. Written for ace from its own testing.
 */
const notes: ReadonlyMap<string, string> = new Map([
  [
    "com.tinyspeck.slackmacgap",
    "Slack: Return sends the message being typed. For multi-line text use set_value on the message field, or key shift+Return between lines. The outline can lag behind new messages; take a screenshot to confirm what was sent.",
  ],
  [
    "com.apple.MobileSMS",
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
    "com.apple.Notes",
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
  return notes.get(bundleId);
}
