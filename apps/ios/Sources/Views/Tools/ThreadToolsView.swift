import SwiftUI

struct ThreadToolsView: View {
    let model: ClientModel
    let thread: ThreadModel
    let openThread: (String) -> Void
    var body: some View {
        List {
            NavigationLink { TerminalView(model: model, threadId: thread.id) } label: { Label("Terminal", systemImage: "terminal") }
            NavigationLink { ThreadCatalogView(model: model, threadId: thread.id) } label: { Label("Skills and commands", systemImage: "book") }
            NavigationLink { ThreadMcpView(model: model, threadId: thread.id) } label: { Label("MCP servers", systemImage: "network") }
        }
        .navigationTitle("Thread tools").navigationBarTitleDisplayMode(.inline)
    }
}
