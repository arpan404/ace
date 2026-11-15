import SwiftUI

extension View {
    /// Keeps the open thread's quotes with its draft words on this phone (`ThreadDrafts`, by
    /// machine and thread), so a relaunch gives back both: each visit first hands the kept quotes
    /// to the bridge, then keeps what the bridge says it holds, emptied once a message took them.
    func keepsThreadQuotes(model: ClientModel, thread: ThreadModel) -> some View {
        modifier(ThreadQuoteKeeping(model: model, thread: thread))
    }
}

private struct ThreadQuoteKeeping: ViewModifier {
    let model: ClientModel
    let thread: ThreadModel
    @Environment(\.threadDrafts) private var drafts
    /// The visit whose kept quotes went back to the bridge: only its reports are kept after.
    @State private var restored: Int?
    private var key: String? { model.hostId.map { ThreadDrafts.key(hostId: $0, threadId: thread.id) } }

    func body(content: Content) -> some View {
        content
            .task(id: thread.epoch) {
                // A view-only pairing takes no quotes, so it never keeps an emptied list over them.
                guard model.canOperate, let key, let drafts else { return }
                model.restoreQuotes(drafts.quotes(for: key))
                restored = thread.epoch
            }
            .onChange(of: thread.screen.keptQuotes) { _, kept in
                guard let kept, restored == thread.epoch, let key else { return }
                drafts?.save(quotes: kept, for: key)
            }
    }
}
