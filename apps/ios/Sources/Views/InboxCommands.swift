import SwiftUI

/// What the hardware keyboard's thread commands do in the focused window: New thread, Search,
/// and the next or previous thread in the list. Each window publishes its own, so a command acts
/// on the window in front.
struct InboxCommands {
    /// Nil while every machine is view-only.
    let newThread: (() -> Void)?
    let search: () -> Void
    let next: () -> Void
    let previous: () -> Void
}

extension FocusedValues {
    @Entry var inboxCommands: InboxCommands?
}

extension View {
    func inboxCommands(_ commands: InboxCommands) -> some View { focusedSceneValue(\.inboxCommands, commands) }
}

/// The Threads menu: in the iPad menu bar and the overlay held ⌘ shows. Send (⌘↩) belongs to the
/// composer's button and Close (Esc) to each sheet's.
struct ThreadCommands: Commands {
    @FocusedValue(\.inboxCommands) private var inbox

    var body: some Commands {
        CommandMenu("Threads") {
            Button("New Thread") { inbox?.newThread?() }
                .keyboardShortcut("n", modifiers: .command)
                .disabled(inbox?.newThread == nil)
            Button("Search Threads") { inbox?.search() }
                .keyboardShortcut("f", modifiers: .command)
                .disabled(inbox == nil)
            Divider()
            Button("Next Thread") { inbox?.next() }
                .keyboardShortcut(.downArrow, modifiers: [.command, .option])
                .disabled(inbox == nil)
            Button("Previous Thread") { inbox?.previous() }
                .keyboardShortcut(.upArrow, modifiers: [.command, .option])
                .disabled(inbox == nil)
        }
    }
}
