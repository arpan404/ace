import SwiftUI

extension EnvironmentValues {
    /// Set on a screen shown as one of a thread's pages, under the thread's own bar: it keeps no
    /// navigation stack or close of its own and leaves the title's place to the thread. (The
    /// Changes branch declares the same entry beside ChangesSheet; keep one when they meet.)
    @Entry var threadPage = false
}

extension ThreadPageKind {
    /// Buttons the page puts in the thread's bar. A page with its own takes the bar's trailing
    /// side; the thread's ⋯ shows on the pages without (Chat, Changes, Agents).
    var barButtons: Int {
        switch self {
        case .browser, .terminal: 2
        case .files: 1
        default: 0
        }
    }
}

/// One of the thread's pages other than Chat, as a phone shows it under the thread's title: the
/// same screen the iPad's side panel holds, without a close of its own (the pill row and a
/// swipe leave it). It clears the composer at the bottom, which stays on every page.
struct ThreadPageBody: View {
    let kind: ThreadPageKind
    @Bindable var model: ClientModel
    @Bindable var thread: ThreadModel
    let title: String
    let subtitle: String
    /// The composer block's height: the page's content ends above it.
    let barHeight: CGFloat
    let openThread: (String) -> Void
    let openAgent: (SubagentRoute) -> Void
    let openChat: () -> Void
    /// Puts a file or a page into the composer; nil when this phone can't send.
    let mention: ((ComposerMention) -> Void)?

    var body: some View {
        page
            // Screens that are sheets elsewhere drop their close here; their Esc goes to Chat.
            .environment(\.panelHost, PanelHost(hide: openChat))
            .environment(\.threadPage, true)
            .safeAreaPadding(.bottom, barHeight)
            .accessibilityIdentifier("thread.page.\(kind.rawValue).body")
    }

    @ViewBuilder private var page: some View {
        switch kind {
        case .chat: EmptyView()
        case .changes: ChangesSheet(model: model, title: title)
        case .files: FilesScreen(model: model, scope: .thread(thread.id), subtitle: subtitle, mention: mention)
        case .terminal: TerminalView(model: model, threadId: thread.id)
        case .browser:
            let help = thread.approvals.first { $0.kind == "browser_help" }
            BrowserScreen(model: model, help: help, toMessage: { tab in
                // Back to Chat, the page in the message when asked about.
                if let tab { mention?(ComposerMention(path: "", tab: tab)) }
                openChat()
            }) { answer in if let help { model.resolve(help, answer: answer) } }
        case .agents:
            AgentTreePage(model: model, thread: thread, openAgent: openAgent, openThread: openThread, openChat: openChat)
        }
    }
}
