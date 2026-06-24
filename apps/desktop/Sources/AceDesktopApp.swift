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
            }
        }
    }
}
