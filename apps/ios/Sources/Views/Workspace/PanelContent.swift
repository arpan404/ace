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
    /// Puts `@path` into the composer; nil when this device can't send.
    let mention: ((String) -> Void)?

    var body: some View {
        switch tool {
        // These two bring their own stack, as sheets.
        case .changes: ChangesSheet(model: model, title: title)
        case .agents: AgentsSheet(model: model, thread: thread, openThread: openThread)
        case .files:
            NavigationStack { FilesScreen(model: model, scope: .thread(thread.id), subtitle: subtitle, mention: mention) }
        case .terminal:
            NavigationStack { TerminalView(model: model, threadId: thread.id) }
        case .browser:
            NavigationStack {
                let help = thread.approvals.first { $0.kind == "browser_help" }
                BrowserScreen(model: model, help: help) { answer in if let help { model.resolve(help, answer: answer) } }
            }
        }
    }
}
