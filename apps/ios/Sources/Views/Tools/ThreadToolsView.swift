import SwiftUI

/// The thread's tools, as the grouped list every other list page uses: one group, a glyph per
/// row, and the system's chevron to the page each opens.
struct ThreadToolsView: View {
    let model: ClientModel
    let thread: ThreadModel
    let openThread: (String) -> Void
    var body: some View {
        List {
            Section {
                NavigationLink { TerminalView(model: model, threadId: thread.id) } label: { InsetRow("Terminal", icon: .terminalWindow) }
                    .accessibilityIdentifier("threadTools.terminal")
                NavigationLink { ThreadCatalogView(model: model, threadId: thread.id) } label: { InsetRow("Skills and commands", icon: .command) }
                    .accessibilityIdentifier("threadTools.catalog")
                NavigationLink { ThreadMcpView(model: model, threadId: thread.id) } label: { InsetRow("MCP servers", icon: .plugsConnected) }
                    .accessibilityIdentifier("threadTools.mcp")
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .toolbar { SheetClose() }
        .navigationTitle("Thread tools").navigationBarTitleDisplayMode(.inline)
    }
}
