import SwiftUI

/// The screen a panel tab shows: the same screen the phone opens over the thread, on its own
/// navigation stack so what it pushes (a file, an agent's transcript) stays in the panel. Only
/// the tab showing is built; another tab's screen starts again when picked, as on the web.
struct PanelContent: View {
    let tool: PanelTool
    @Bindable var model: ClientModel
    @Bindable var thread: ThreadModel
    let title: String
    let subtitle: String
    let openThread: (String) -> Void
    /// The scope the Changes tab opens on, set by the Summary tab and cleared once shown.
    @Binding var changesScope: String?
    /// Puts `@path` (or `@path:12-20`) into the composer; nil when this device can't send.
    let mention: ((ComposerMention) -> Void)?

    var body: some View {
        switch tool {
        // These two bring their own stack, as sheets.
        case .changes: ChangesSheet(model: model, title: title, scope: changesScope, scopeShown: { changesScope = nil })
        case .agents: AgentsSheet(model: model, thread: thread, openThread: openThread)
        case .summary:
            PanelSummary(model: model, thread: thread, openThread: openThread,
                         openAgents: { model.panel(thread.id, ["op": "open", "kind": PanelTool.agents.rawValue]) },
                         openChanges: {
                             changesScope = "all"
                             model.panel(thread.id, ["op": "open", "kind": PanelTool.changes.rawValue])
                         })
        case .files:
            NavigationStack { FilesScreen(model: model, scope: .thread(thread.id), subtitle: subtitle, mention: mention) }
        case .terminal:
            NavigationStack { TerminalView(model: model, threadId: thread.id) }
        case .preview:
            // A dev server opens in the panel's own Browser tab.
            NavigationStack {
                ProjectScriptsView(model: model, threadId: thread.id) { url in
                    model.browserNewTab(url)
                    model.panel(thread.id, ["op": "open", "kind": PanelTool.browser.rawValue])
                }
            }
        case .browser:
            NavigationStack {
                let help = thread.approvals.first { $0.kind == "browser_help" }
                BrowserScreen(model: model, help: help) { answer in if let help { model.resolve(help, answer: answer) } }
            }
        }
    }
}

/// The Summary tab. An asking agent that lives in this thread opens its transcript on the tab's
/// own stack, as the phone pushes it over the thread.
private struct PanelSummary: View {
    @Bindable var model: ClientModel
    @Bindable var thread: ThreadModel
    let openThread: (String) -> Void
    let openAgents: () -> Void
    let openChanges: () -> Void
    @State private var path: [SubagentRoute] = []

    var body: some View {
        NavigationStack(path: $path) {
            ThreadSummaryPage(model: model, thread: thread, openThread: openThread, openAgents: openAgents,
                              openChanges: openChanges, openAgent: { path.append($0) })
                .navigationTitle("Summary")
                .navigationBarTitleDisplayMode(.inline)
                .navigationDestination(for: SubagentRoute.self) { route in
                    SubagentView(route: route, model: model, thread: thread, push: { path.append($0) },
                                 openThread: openThread)
                }
        }
    }
}
