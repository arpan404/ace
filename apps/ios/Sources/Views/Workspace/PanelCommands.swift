import SwiftUI

/// The side panel's keys, the web's own (`apps/web/src/lib/keymap.ts`): each repeats a control in
/// the thread bar or the panel's tab strip. Published by the thread showing, only while its
/// panel has room, so a phone or a narrow window lists none of them.
struct PanelCommands {
    /// Sends one action to the shared rules for this thread's panel.
    let act: ([String: Any]) -> Void
    let hasTab: Bool
    let canReopen: Bool
    /// The tab showing, for Close tab; nil when it is pinned or there is none.
    let closable: String?

    /// Each key, in the menu's order. `nil` actions are listed but can't be used now.
    struct Key: Identifiable {
        let title: String
        let key: KeyEquivalent
        let modifiers: EventModifiers
        let run: (() -> Void)?
        var id: String { title }
    }
    var keys: [[Key]] {
        let tool = { (kind: PanelTool) in { act(["op": "toggle", "kind": kind.rawValue]) } }
        return [
            [Key(title: "Show or Hide Panel", key: "b", modifiers: [.command, .shift], run: { act(["op": "togglePanel"]) })],
            [
                Key(title: "Changes", key: "d", modifiers: [.command, .shift], run: tool(.changes)),
                Key(title: "Files", key: "p", modifiers: .command, run: tool(.files)),
                Key(title: "Terminal", key: "`", modifiers: .control, run: tool(.terminal)),
                Key(title: "Browser", key: "b", modifiers: [.control, .shift], run: tool(.browser)),
                Key(title: "Agents", key: "a", modifiers: [.control, .shift], run: tool(.agents)),
            ],
            [
                Key(title: "Next Tab", key: "]", modifiers: [.command, .shift], run: hasTab ? { act(["op": "cycle", "delta": 1]) } : nil),
                Key(title: "Previous Tab", key: "[", modifiers: [.command, .shift], run: hasTab ? { act(["op": "cycle", "delta": -1]) } : nil),
                Key(title: "Close Tab", key: "w", modifiers: [.command, .option], run: closable.map { key in { act(["op": "close", "key": key]) } }),
                Key(title: "Reopen Closed Tab", key: "t", modifiers: [.command, .option, .shift], run: canReopen ? { act(["op": "reopen"]) } : nil),
            ],
        ]
    }
}

extension FocusedValues {
    @Entry var panelCommands: PanelCommands?
}

extension View {
    /// Publishes the panel's keys to the menu bar (iPadOS 26), and before iPadOS 26 on invisible
    /// buttons in the thread, which the ⌘-hold overlay lists too.
    func panelCommands(_ commands: PanelCommands?) -> some View {
        focusedSceneValue(\.panelCommands, commands)
            .background { if #unavailable(iOS 26), let commands { PanelCommandKeys(commands: commands) } }
    }
}

private struct PanelCommandKeys: View {
    let commands: PanelCommands
    var body: some View {
        ZStack {
            ForEach(commands.keys.flatMap { $0 }) { key in
                if let run = key.run { Button(key.title, action: run).keyboardShortcut(key.key, modifiers: key.modifiers) }
            }
        }
        .opacity(0)
        .frame(width: 0, height: 0)
        .accessibilityHidden(true)
    }
}

/// The Panel menu, beside Threads in the iPad menu bar and the ⌘-hold overlay. Empty, it hides.
struct PanelMenuCommands: Commands {
    @FocusedValue(\.panelCommands) private var panel

    var body: some Commands {
        CommandMenu("Panel") {
            if let panel {
                ForEach(Array(panel.keys.enumerated()), id: \.offset) { index, group in
                    if index > 0 { Divider() }
                    ForEach(group) { key in
                        Button(key.title) { key.run?() }
                            .keyboardShortcut(key.key, modifiers: key.modifiers)
                            .disabled(key.run == nil)
                    }
                }
            }
        }
    }
}
