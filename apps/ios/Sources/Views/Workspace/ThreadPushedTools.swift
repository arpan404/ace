import SwiftUI

/// The thread's screens a phone pushes over it from ⋯: Terminal, Browser, Agents and Summary (Files is
/// pushed by `ThreadFileRoutes`, which owns the file links too). Each is the full screen with
/// its own title and bar; back returns to the thread, on the page it left.
struct ThreadPushedTools: ViewModifier {
    @Bindable var model: ClientModel
    @Bindable var thread: ThreadModel
    @Binding var pushed: ThreadPushedTool?
    let openThread: (String) -> Void
    let openAgent: (SubagentRoute) -> Void
    /// Back to the thread on its Changes page.
    var openChanges: (() -> Void)? = nil
    /// Puts a page into the composer; nil when this phone can't send.
    let mention: ((ComposerMention) -> Void)?

    func body(content: Content) -> some View {
        content
            .navigationDestination(isPresented: showing(.terminal)) {
                TerminalView(model: model, threadId: thread.id)
            }
            .navigationDestination(isPresented: showing(.browser)) {
                let help = thread.approvals.first { $0.kind == "browser_help" }
                BrowserScreen(model: model, help: help, toMessage: { tab in
                    // Back to the thread, the page in the message when asked about.
                    if let tab { mention?(ComposerMention(path: "", tab: tab)) }
                    pushed = nil
                }) { answer in if let help { model.resolve(help, answer: answer) } }
            }
            .navigationDestination(isPresented: showing(.agents)) {
                AgentTreePage(model: model, thread: thread, openAgent: openAgent, openThread: openThread,
                              openChat: { pushed = nil })
                    .navigationTitle("Agents")
                    .navigationBarTitleDisplayMode(.inline)
            }
            .navigationDestination(isPresented: showing(.summary)) {
                ThreadSummaryPage(model: model, thread: thread, openThread: openThread,
                                  openAgents: { pushed = .agents }, openChanges: openChanges, openAgent: openAgent)
                    .navigationTitle("Summary")
                    .navigationBarTitleDisplayMode(.inline)
            }
    }

    /// Whether `tool` is pushed; popping it clears the push.
    func showing(_ tool: ThreadPushedTool) -> Binding<Bool> {
        Binding(get: { pushed == tool }, set: { shown in
            if shown { pushed = tool } else if pushed == tool { pushed = nil }
        })
    }
}
