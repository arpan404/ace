# Keybindings

ace keybindings are defined in three layers:

- `packages/contracts/src/keybindings.ts`: shared command list, schema, limits, and resolved AST types
- `apps/server/src/keybindings.ts`: default bindings, parsing, validation, persistence, and config issue reporting
- `apps/web/src/lib/keybindingRegistry.ts`: user-facing labels, categories, descriptions, and example contexts for the Settings UI

The user-editable source of truth is:

- `~/.ace/keybindings.json`

You can manage shortcuts directly in **Settings → Advanced → Keybindings**. Edits are persisted to
that same file.

## File Format

The file is a JSON array of rules:

```json
[
  { "key": "mod+j", "command": "terminal.toggle" },
  { "key": "mod+d", "command": "terminal.split", "when": "terminalFocus" },
  { "key": "mod+\\", "command": "editor.split", "when": "editorFocus" }
]
```

See the full schema for more details: [`packages/contracts/src/keybindings.ts`](packages/contracts/src/keybindings.ts)

## Defaults

Defaults are owned by [`DEFAULT_KEYBINDINGS` in `apps/server/src/keybindings.ts`](apps/server/src/keybindings.ts).
That server-side list is the canonical runtime source.

Current default coverage includes:

- Sidebar: `search.open`, `sidebar.toggle`, `navigation.back`, `navigation.forward`, `project.add`
- Terminal: `terminal.toggle`, `terminal.split`, `terminal.new`, `terminal.close`
- Right panel: `rightPanel.toggle`, `rightPanel.review.open`, `rightPanel.browser.open`, `rightPanel.editor.open`
- Browser: `browser.back`, `browser.forward`, `browser.newTab`, `browser.closeTab`, `browser.focusAddressBar`, `browser.reload`, `browser.devtools`, `browser.previousTab`, `browser.nextTab`, `browser.designer.areaComment`, `browser.designer.elementComment`
- Chat: `chat.new`, `chat.newLocal`, `chat.togglePlanMode`, `chat.toggleHeader`
- Editor: `editor.openFavorite`, `editor.newFile`, `editor.newFolder`, `editor.rename`, `editor.split`, `editor.splitDown`, `editor.toggleWordWrap`, `editor.closeTab`, `editor.closeOtherTabs`, `editor.closeTabsToRight`, `editor.reopenClosedTab`, `editor.closeWindow`, `editor.focusNextWindow`, `editor.focusPreviousWindow`, `editor.nextTab`, `editor.previousTab`, `editor.moveTabLeft`, `editor.moveTabRight`
- Threads: `thread.previous`, `thread.next`, `thread.jump.1` through `thread.jump.9`

Selected defaults:

```json
[
  { "key": "mod+k", "command": "search.open", "when": "!terminalFocus" },
  { "key": "mod+j", "command": "terminal.toggle" },
  { "key": "mod+d", "command": "rightPanel.review.open", "when": "!terminalFocus" },
  { "key": "mod+b", "command": "rightPanel.browser.open", "when": "!terminalFocus" },
  { "key": "mod+e", "command": "rightPanel.editor.open", "when": "!terminalFocus" },
  { "key": "mod+shift+p", "command": "chat.togglePlanMode", "when": "!terminalFocus" },
  { "key": "mod+shift+h", "command": "chat.toggleHeader", "when": "!terminalFocus" },
  { "key": "mod+[", "command": "browser.back", "when": "browserOpen && !terminalFocus" },
  { "key": "mod+]", "command": "browser.forward", "when": "browserOpen && !terminalFocus" },
  {
    "key": "mod+alt+1",
    "command": "browser.designer.areaComment",
    "when": "browserOpen && !terminalFocus"
  },
  {
    "key": "mod+alt+2",
    "command": "browser.designer.elementComment",
    "when": "browserOpen && !terminalFocus"
  },
  { "key": "mod+shift+[", "command": "thread.previous", "when": "!browserOpen" },
  { "key": "mod+shift+]", "command": "thread.next", "when": "!browserOpen" },
  { "key": "mod+1", "command": "thread.jump.1" }
]
```

## Configuration

Each entry supports:

- `key` (required): shortcut string, like `mod+j`, `ctrl+k`, `cmd+shift+d`
- `command` (required): action ID
- `when` (optional): boolean expression controlling when the shortcut is active

The server parses each rule into a resolved form:

- `key` becomes a structured `shortcut`
- `when` becomes a boolean-expression AST (`whenAst`)

Invalid files fall back to defaults without overwriting the file. Invalid entries are skipped
individually and reported as config issues.

### Available Commands

- `search.open`: open the command search panel
- `sidebar.toggle`: collapse or expand the main sidebar
- `navigation.back`: navigate back in app history
- `navigation.forward`: navigate forward in app history
- `terminal.toggle`: open/close terminal drawer
- `terminal.split`: split terminal (in focused terminal context by default)
- `terminal.new`: create new terminal (in focused terminal context by default)
- `terminal.close`: close/kill the focused terminal (in focused terminal context by default)
- `rightPanel.toggle`: show/hide the right side panel without selecting a tab
- `rightPanel.review.open`: open the Review tab
- `rightPanel.browser.open`: open the Browser tab
- `rightPanel.editor.open`: open the Editor tab
- `browser.back`: navigate browser history backward
- `browser.forward`: navigate browser history forward
- `browser.newTab`: add a Browser tab
- `browser.closeTab`: close the active Browser tab
- `browser.focusAddressBar`: focus the Browser address bar
- `browser.reload`: reload the active Browser tab
- `browser.devtools`: toggle browser DevTools
- `browser.previousTab`: focus the previous Browser tab
- `browser.nextTab`: focus the next Browser tab
- `browser.designer.areaComment`: toggle the area comment tool
- `browser.designer.elementComment`: toggle the element comment tool
- `chat.new`: create a new chat thread preserving the active thread's branch/worktree state
- `chat.newLocal`: create a new chat thread for the active project in a new environment (local/worktree determined by app settings (default `local`))
- `project.add`: open the add-project command browser
- `chat.toggleWorkspaceMode`: toggle between chat and editor workspace modes
- `chat.togglePlanMode`: toggle the composer between plan and execute modes
- `chat.toggleHeader`: hide/show the chat top header
- `editor.openFavorite`: open current project/worktree in the last-used editor
- `editor.newFile`: create a new file in the workspace
- `editor.newFolder`: create a new folder in the workspace
- `editor.rename`: rename the selected file or folder
- `editor.split`: split the focused workspace editor into a new window
- `editor.splitDown`: split the focused editor downward
- `editor.toggleWordWrap`: toggle word wrap in the active editor
- `editor.closeTab`: close the active editor tab
- `editor.closeOtherTabs`: close all tabs except the active one
- `editor.closeTabsToRight`: close tabs to the right of the active tab
- `editor.reopenClosedTab`: reopen the most recently closed editor tab
- `editor.closeWindow`: close the focused workspace editor window
- `editor.focusPreviousWindow`: focus the previous workspace editor window
- `editor.focusNextWindow`: focus the next workspace editor window
- `editor.previousTab`: focus the previous tab in the active workspace editor window
- `editor.nextTab`: focus the next tab in the active workspace editor window
- `editor.moveTabLeft`: move the active workspace editor tab left
- `editor.moveTabRight`: move the active workspace editor tab right
- `thread.previous`: move to the previous visible thread
- `thread.next`: move to the next visible thread
- `thread.jump.1` through `thread.jump.9`: jump to a visible thread by index
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
- `mod+shift++`
- `mod+[`
- `mod+alt+1`
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

- Rules are evaluated from the end of the array back to the start.
- The last rule whose shortcut and `when` clause both match wins.
- Precedence applies across commands, not only within one command.
- This is why overrides belong later in the file.

### Settings UI

The Settings UI metadata comes from [`apps/web/src/lib/keybindingRegistry.ts`](apps/web/src/lib/keybindingRegistry.ts).
That registry is intentionally presentation-only:

- categories
- labels
- descriptions
- example matching contexts
- default shortcut labels for display

Runtime behavior still comes from the resolved config pushed by the server.
