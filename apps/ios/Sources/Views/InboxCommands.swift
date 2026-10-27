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
    /// Publishes the window's commands to the menu bar (iPadOS 26). Before iPadOS 26 the menu
    /// never reaches them: the same keys sit on invisible buttons in the window's own content,
    /// which the ⌘-hold overlay lists too.
    func inboxCommands(_ commands: InboxCommands) -> some View {
        focusedSceneValue(\.inboxCommands, commands)
            .background { if #unavailable(iOS 26) { InboxCommandKeys(commands: commands) } }
    }
}

private struct InboxCommandKeys: View {
    let commands: InboxCommands
    var body: some View {
        ZStack {
            if let newThread = commands.newThread { Button("New Thread", action: newThread).phoneShortcut("newThread") }
            Button("Search Threads", action: commands.search).phoneShortcut("searchThreads")
            Button("Next Thread", action: commands.next).phoneShortcut("nextThread")
            Button("Previous Thread", action: commands.previous).phoneShortcut("previousThread")
        }
        .opacity(0)
        .frame(width: 0, height: 0)
        .accessibilityHidden(true)
    }
}

/// The Threads menu: in the iPad menu bar and the overlay held ⌘ shows, with this phone's keys
/// (Settings › Keyboard). Send belongs to the composer's button, the sidebar to its button and
/// Close (Esc) to each sheet's; the overlay lists those while they show.
struct ThreadCommands: Commands {
    @FocusedValue(\.inboxCommands) private var inbox
    @FocusedValue(\.recordingShortcut) private var recording
    @AppStorage(PhoneKeymap.storageKey) private var stored = ""

    var body: some Commands {
        // While Settings › Keyboard records keys, a pressed shortcut is recorded, not run.
        let keymap = PhoneKeymap(stored: stored)
        let inbox = recording == true ? nil : inbox
        CommandMenu("Threads") {
            Button("New Thread") { inbox?.newThread?() }
                .keyboardShortcut(keymap.shortcut("newThread"))
                .disabled(inbox?.newThread == nil)
            Button("Search Threads") { inbox?.search() }
                .keyboardShortcut(keymap.shortcut("searchThreads"))
                .disabled(inbox == nil)
            Divider()
            Button("Next Thread") { inbox?.next() }
                .keyboardShortcut(keymap.shortcut("nextThread"))
                .disabled(inbox == nil)
            Button("Previous Thread") { inbox?.previous() }
                .keyboardShortcut(keymap.shortcut("previousThread"))
                .disabled(inbox == nil)
        }
    }
}
