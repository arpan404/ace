import SwiftUI

@main
struct AceDesktopApp: App {
    @StateObject private var store = AppStore(
        client: AceWebSocketClient(endpoint: URL(string: "ws://127.0.0.1:3773/api/ws")!)
    )

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .task {
                    await store.bootstrap()
                }
                .frame(minWidth: 980, minHeight: 640)
        }
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Thread") {
                    Task { await store.createThread() }
                }
                .keyboardShortcut("n", modifiers: [.command])
            }
            CommandMenu("Ace") {
                Button("Focus Sidebar") {
                    store.focusSidebar()
                }
                .keyboardShortcut("1", modifiers: [.command])

                Button("Focus Composer") {
                    store.focusComposer()
                }
                .keyboardShortcut("l", modifiers: [.command])

                Divider()

                Button(store.sidebarCollapsed ? "Show Sidebar" : "Hide Sidebar") {
                    store.toggleSidebar()
                }
                .keyboardShortcut("b", modifiers: [.command])

                Button("Add Project") {
                    store.presentAddProject()
                }
                .keyboardShortcut("o", modifiers: [.command])

                Button("Refresh") {
                    Task { await store.refresh() }
                }
                .keyboardShortcut("r", modifiers: [.command])

                Divider()

                Button("Open Selected Item") {
                    Task { await store.activateSelectedSidebarItem() }
                }
                .keyboardShortcut(.return, modifiers: [])

                Button("Previous Sidebar Item") {
                    store.selectPreviousSidebarItem()
                }
                .keyboardShortcut(.upArrow, modifiers: [])

                Button("Next Sidebar Item") {
                    store.selectNextSidebarItem()
                }
                .keyboardShortcut(.downArrow, modifiers: [])

                Button("Pin Selected Item") {
                    store.togglePinnedSelectedItem()
                }
                .keyboardShortcut("p", modifiers: [.command, .shift])

                Divider()

                Button("Keyboard Shortcuts") {
                    store.presentShortcuts()
                }
                .keyboardShortcut("/", modifiers: [.command])
            }
        }
    }
}
