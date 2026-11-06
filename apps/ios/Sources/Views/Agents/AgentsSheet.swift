import SwiftUI

/// The agent tree on a stack of its own: the iPad side panel's Agents tab, and anywhere the tree
/// opens over the thread. The tree is the phone's Agents page (`AgentTreePage`); a native
/// subagent's transcript pushes on this stack, a child thread leaves it and opens.
struct AgentsSheet: View {
    @Bindable var model: ClientModel
    @Bindable var thread: ThreadModel
    /// Pushes an agent that runs as its own ace thread; its transcript lives there.
    var openThread: ((String) -> Void)? = nil
    @State private var path: [SubagentRoute] = []
    @Environment(\.dismiss) private var dismiss
    @Environment(\.panelHost) private var panelHost

    var body: some View {
        NavigationStack(path: $path) {
            AgentTreePage(model: model, thread: thread, openAgent: { path.append($0) },
                          openThread: openThread.map { open in { child in dismiss(); open(child) } },
                          openChat: panelHost == nil ? { dismiss() } : nil)
                .navigationTitle("Agents")
                .navigationBarTitleDisplayMode(.inline)
                .navigationDestination(for: SubagentRoute.self) { route in
                    SubagentView(route: route, model: model, thread: thread, push: { path.append($0) },
                                 openThread: { child in dismiss(); openThread?(child) })
                }
                .sheetEscape { dismiss() }
                .toolbar {
                    if panelHost == nil {
                        ToolbarItem(placement: .cancellationAction) {
                            Button { dismiss() } label: { Image(systemName: "xmark") }
                                .accessibilityLabel("Close").accessibilityIdentifier("agents.close")
                        }
                    }
                }
        }
        .tint(AceDesign.Ink.accent)
    }
}
