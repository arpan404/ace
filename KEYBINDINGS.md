# Keybindings

ace reads keybindings from:

- `~/.ace/keybindings.json`

You can manage shortcuts directly in **Settings → Advanced → Keybindings**. Changes are saved to
the same `keybindings.json` file.

The file must be a JSON array of rules:

```json
[
  { "key": "mod+g", "command": "terminal.toggle" },
  { "key": "mod+shift+g", "command": "terminal.new", "when": "terminalFocus" },
  { "key": "mod+\\", "command": "editor.split", "when": "editorFocus" }
]
```

See the full schema for more details: [`packages/contracts/src/keybindings.ts`](packages/contracts/src/keybindings.ts)

## Defaults

```json
[
  { "key": "mod+shift+b", "command": "sidebar.toggle" },
  { "key": "mod+j", "command": "terminal.toggle" },
  { "key": "mod+d", "command": "terminal.split", "when": "terminalFocus" },
  { "key": "mod+n", "command": "terminal.new", "when": "terminalFocus" },
  { "key": "mod+w", "command": "terminal.close", "when": "terminalFocus" },
  { "key": "mod+n", "command": "chat.new", "when": "!terminalFocus" },
  { "key": "mod+shift+o", "command": "chat.new", "when": "!terminalFocus" },
  { "key": "mod+shift+n", "command": "chat.newLocal", "when": "!terminalFocus" },
  { "key": "mod+e", "command": "chat.toggleWorkspaceMode", "when": "!terminalFocus" },
  { "key": "mod+shift+h", "command": "chat.toggleHeader", "when": "!terminalFocus" },
  { "key": "mod+o", "command": "editor.openFavorite" },
  { "key": "mod+\\", "command": "editor.split", "when": "editorFocus" },
  { "key": "mod+alt+arrowleft", "command": "editor.focusPreviousWindow", "when": "editorFocus" },
  { "key": "mod+alt+arrowright", "command": "editor.focusNextWindow", "when": "editorFocus" },
  { "key": "alt+shift+arrowleft", "command": "editor.previousTab", "when": "editorFocus" },
  { "key": "alt+shift+arrowright", "command": "editor.nextTab", "when": "editorFocus" },
  { "key": "mod+alt+shift+arrowleft", "command": "editor.moveTabLeft", "when": "editorFocus" },
  { "key": "mod+alt+shift+arrowright", "command": "editor.moveTabRight", "when": "editorFocus" }
]
```

For most up to date defaults, see [`DEFAULT_KEYBINDINGS` in `apps/server/src/keybindings.ts`](apps/server/src/keybindings.ts)

## Configuration

### Rule Shape

Each entry supports:

- `key` (required): shortcut string, like `mod+j`, `ctrl+k`, `cmd+shift+d`
- `command` (required): action ID
- `when` (optional): boolean expression controlling when the shortcut is active

Invalid rules are ignored. Invalid config files are ignored. Warnings are logged by the server.

### Available Commands

- `terminal.toggle`: open/close terminal drawer
- `terminal.split`: split terminal (in focused terminal context by default)
- `terminal.new`: create new terminal (in focused terminal context by default)
- `terminal.close`: close/kill the focused terminal (in focused terminal context by default)
- `sidebar.toggle`: collapse/expand the sidebar
- `chat.new`: create a new chat thread preserving the active thread's branch/worktree state
- `chat.newLocal`: create a new chat thread for the active project in a new environment (local/worktree determined by app settings (default `local`))
- `chat.toggleWorkspaceMode`: toggle between chat and editor workspace modes
- `chat.toggleHeader`: hide/show the chat top header
- `editor.openFavorite`: open current project/worktree in the last-used editor
- `editor.split`: split the focused workspace editor into a new window
- `editor.closeWindow`: close the focused workspace editor window
- `editor.focusPreviousWindow`: focus the previous workspace editor window
- `editor.focusNextWindow`: focus the next workspace editor window
- `editor.previousTab`: focus the previous tab in the active workspace editor window
- `editor.nextTab`: focus the next tab in the active workspace editor window
- `editor.moveTabLeft`: move the active workspace editor tab left
- `editor.moveTabRight`: move the active workspace editor tab right
- `script.{id}.run`: run a project script by id (for example `script.test.run`)

### Key Syntax

Supported modifiers:

- `mod` (`cmd` on macOS, `ctrl` on non-macOS)
- `cmd` / `meta`
- `ctrl` / `control`
- `shift`
- `alt` / `option`

Examples:

- `mod+j`
- `mod+shift+d`
- `ctrl+l`
- `cmd+k`

### `when` Conditions

Currently available context keys:

- `terminalFocus`
- `terminalOpen`
- `browserOpen`
- `editorFocus`

Supported operators:

- `!` (not)
- `&&` (and)
- `||` (or)
- parentheses: `(` `)`

Examples:

- `"when": "terminalFocus"`
- `"when": "terminalOpen && !terminalFocus"`
- `"when": "editorFocus"`
- `"when": "terminalFocus || terminalOpen"`

Unknown condition keys evaluate to `false`.

### Precedence

- Rules are evaluated in array order.
- For a key event, the last rule where both `key` matches and `when` evaluates to `true` wins.
- That means precedence is across commands, not only within the same command.
