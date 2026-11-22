import SwiftUI

/// A thread opening before its machine has answered: what the feed says meanwhile
/// (`ThreadOpening`).
extension ConversationFeed {
    /// What the feed says while its rows aren't the machine's own yet.
    var opening: ThreadOpening {
        let row = model.inbox[thread.id] ?? thread.metadata
        return .of(.init(loaded: ready, rows: thread.screen.blockOrder.count, connection: model.connection,
                         problem: model.problem?.message, machine: row?.machine))
    }

    /// Retry from the opening's placeholder or its syncing line (`ClientModel.retryOpening`).
    func retryOpening() { model.retryOpening(thread.id) }
}
