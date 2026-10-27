import SwiftUI

/// What the hardware keyboard's list commands do in the focused window: New thread, Search
/// everything, Select, Settings, and the next or previous thread in the list. Each window
/// publishes its own, so a command acts on the window in front.
struct InboxCommands {
    /// Nil while every machine is view-only.
    let newThread: (() -> Void)?
    let search: () -> Void
    var select: () -> Void = {}
    var settings: () -> Void = {}
    let next: () -> Void
    let previous: () -> Void
    /// The next thread that needs the person, after the open one.
    var nextNeedsYou: () -> Void = {}
}

/// The open thread's own commands: its places (Changes, Agent tree, Files…), Stop, and its row's
/// shared actions (`threadMenu`). Its page publishes them, so they act on the thread in front.
struct ThreadKeys {
    let key: InboxKey
    let open: (ThreadDestination) -> Void
    /// Nil while nothing runs.
    let stop: (() -> Void)?
    /// The thread's shared menu ids, and the inbox's handler for them.
    let menu: [String]
    let organizer: ThreadOrganizer?
    func has(_ id: String) -> Bool { organizer != nil && menu.contains(id) }
    func run(_ id: String) { organizer?.perform(key, id) }
}

extension ThreadDestination {
    /// A search-everything command's place (`thread:changes` → `.changes`).
    init?(command: String) {
        switch command {
        case "changes": self = .changes
        case "agents": self = .agents
        case "search": self = .search
        case "files": self = .files
        case "terminal": self = .terminal
        case "browser": self = .browser
        case "devices": self = .devices
        default: return nil
        }
    }
}

/// Where the open thread leaves its `ThreadKeys` for the list's search-everything commands. A
/// plain holder, never observed: a view reading a focused value that holds closures would redraw
/// whenever any window's commands are published again.
@MainActor final class ThreadKeysBox {
    var keys: ThreadKeys?
}

extension EnvironmentValues {
    @Entry var threadKeysBox: ThreadKeysBox?
}

extension FocusedValues {
    @Entry var inboxCommands: InboxCommands?
    @Entry var threadKeys: ThreadKeys?
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
            Button("Search Everything", action: commands.search).phoneShortcut("searchEverything")
            Button("Search Threads", action: commands.search).phoneShortcut("searchThreads")
            Button("Settings", action: commands.settings).phoneShortcut("settings")
            Button("Next Thread", action: commands.next).phoneShortcut("nextThread")
            Button("Previous Thread", action: commands.previous).phoneShortcut("previousThread")
            Button("Next Thread", action: commands.next).phoneShortcut("nextThreadByArrow")
            Button("Previous Thread", action: commands.previous).phoneShortcut("previousThreadByArrow")
            Button("Next Thread That Needs You", action: commands.nextNeedsYou).phoneShortcut("nextNeedsYou")
        }
        .opacity(0)
        .frame(width: 0, height: 0)
        .accessibilityHidden(true)
    }
}

/// The Threads and Thread menus: in the iPad menu bar and the overlay held ⌘ shows, with this
/// phone's keys (Settings › Keyboard, `@ace/ui-core/phone-keymap`): some rebindable, the rest on
/// the web's keys where iPadOS leaves them free. Thread lists only what the open thread offers
/// now. Send belongs to the composer's button, the sidebar to its button and Close (Esc) to each
/// sheet's; the overlay lists those while they show.
struct ThreadCommands: Commands {
    @FocusedValue(\.inboxCommands) private var inbox
    @FocusedValue(\.threadKeys) private var thread
    @FocusedValue(\.recordingShortcut) private var recording
    @AppStorage(PhoneKeymap.storageKey) private var stored = ""

    var body: some Commands {
        // While Settings › Keyboard records keys, a pressed shortcut is recorded, not run.
        let keymap = PhoneKeymap(stored: stored)
        let inbox = recording == true ? nil : inbox
        let thread = recording == true ? nil : thread
        CommandMenu("Threads") {
            Button("New Thread") { inbox?.newThread?() }
                .keyboardShortcut(keymap.shortcut("newThread"))
                .disabled(inbox?.newThread == nil)
            Button("Search Everything") { inbox?.search() }
                .keyboardShortcut(keymap.shortcut("searchEverything"))
                .disabled(inbox == nil)
            // Search searches the open thread; with none open, the list.
            Button(thread == nil ? "Search Threads" : "Search This Thread") {
                if let thread { thread.open(.search) } else { inbox?.search() }
            }
            .keyboardShortcut(keymap.shortcut("searchThreads"))
            .disabled(inbox == nil && thread == nil)
            Button("Select Threads") { inbox?.select() }
                .keyboardShortcut(keymap.shortcut("selectThreads"))
                .disabled(inbox == nil)
            Divider()
            Button("Next Thread") { inbox?.next() }
                .keyboardShortcut(keymap.shortcut("nextThreadByArrow"))
                .disabled(inbox == nil)
            Button("Previous Thread") { inbox?.previous() }
                .keyboardShortcut(keymap.shortcut("previousThreadByArrow"))
                .disabled(inbox == nil)
            Button("Next Thread That Needs You") { inbox?.nextNeedsYou() }
                .keyboardShortcut(keymap.shortcut("nextNeedsYou"))
                .disabled(inbox == nil)
            Button("Next Thread in List") { inbox?.next() }
                .keyboardShortcut(keymap.shortcut("nextThread"))
                .disabled(inbox == nil)
            Button("Previous Thread in List") { inbox?.previous() }
                .keyboardShortcut(keymap.shortcut("previousThread"))
                .disabled(inbox == nil)
            Divider()
            Button("Settings") { inbox?.settings() }
                .keyboardShortcut(keymap.shortcut("settings"))
                .disabled(inbox == nil)
        }
        CommandMenu("Thread") {
            Button("Show Changes") { thread?.open(.changes) }.keyboardShortcut(keymap.shortcut("showChanges")).disabled(thread == nil)
            Button("Agent Tree") { thread?.open(.agents) }.keyboardShortcut(keymap.shortcut("agentTree")).disabled(thread == nil)
            Button("Open a File") { thread?.open(.files) }.keyboardShortcut(keymap.shortcut("openFile")).disabled(thread == nil)
            Button("Terminal") { thread?.open(.terminal) }.keyboardShortcut(keymap.shortcut("terminal")).disabled(thread == nil)
            Button("Browser") { thread?.open(.browser) }.keyboardShortcut(keymap.shortcut("browser")).disabled(thread == nil)
            Button("Devices") { thread?.open(.devices) }.keyboardShortcut(keymap.shortcut("devices")).disabled(thread == nil)
            Button("Stop All Agents") { thread?.stop?() }.keyboardShortcut(keymap.shortcut("stopAll")).disabled(thread?.stop == nil)
            Divider()
            Button(thread?.has("unpin") == true ? "Unpin" : "Pin") { if let thread { thread.run(thread.has("unpin") ? "unpin" : "pin") } }
                .keyboardShortcut(keymap.shortcut("pin"))
                .disabled(!(thread?.has("pin") == true || thread?.has("unpin") == true))
            Button(thread?.has("read") == true ? "Mark Read" : "Mark Unread") { if let thread { thread.run(thread.has("read") ? "read" : "unread") } }
                .keyboardShortcut(keymap.shortcut("markRead"))
                .disabled(!(thread?.has("read") == true || thread?.has("unread") == true))
            Button(thread?.has("unsettle") == true ? "Unsettle" : "Settle") { if let thread { thread.run(thread.has("unsettle") ? "unsettle" : "settle") } }
                .keyboardShortcut(keymap.shortcut("settle"))
                .disabled(!(thread?.has("settle") == true || thread?.has("unsettle") == true))
            Button("Move to Project…") { thread?.run("move") }.disabled(thread?.has("move") != true)
            Button("Archive") { thread?.run("archive") }.keyboardShortcut(keymap.shortcut("archive")).disabled(thread?.has("archive") != true)
            Button("Delete Thread…") { thread?.run("delete") }.keyboardShortcut(keymap.shortcut("deleteThread")).disabled(thread?.has("delete") != true)
        }
    }
}

/// Publishes the open thread's `ThreadKeys` from a view of its own, so reading the thread's row
/// (its menu ids, whether it can stop) redraws this empty view alone.
struct ThreadKeysPublisher: View {
    let model: ClientModel
    let thread: ThreadModel
    let open: (ThreadDestination) -> Void
    let leave: () -> Void
    @Environment(\.threadOrganizer) private var organizer
    @Environment(\.threadKeysBox) private var box

    var body: some View {
        let keys = keys
        Color.clear.frame(width: 0, height: 0).accessibilityHidden(true)
            .focusedSceneValue(\.threadKeys, keys)
            .onAppear { box?.keys = keys }
            .onChange(of: (keys?.menu ?? []) + [keys?.stop == nil ? "" : "stop"]) { box?.keys = keys }
            .onDisappear { if box?.keys?.key.id == thread.id { box?.keys = nil } }
    }
    private var keys: ThreadKeys? {
        guard let hostId = model.hostId else { return nil }
        let leave = self.leave
        return ThreadKeys(key: InboxKey(machineId: hostId, id: thread.id), open: open,
                          stop: model.canOperate && thread.screen.controls?.canStop == true ? { model.stopTree() } : nil,
                          menu: model.canOperate ? model.inbox[thread.id]?.menu ?? [] : [],
                          organizer: organizer.map { organizer in
                              ThreadOrganizer(perform: { key, id in organizer.perform(key, id); if id == "archive" { leave() } },
                                              snooze: organizer.snooze, wake: organizer.wake)
                          })
    }
}
