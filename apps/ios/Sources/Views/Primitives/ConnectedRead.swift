import SwiftUI

extension View {
    /// For screens whose reads the bridge doesn't keep: runs `read` when the view appears, when
    /// `id` changes, and each time the read cache counts `model`'s machine coming back
    /// (`ReadMirror.reconnects`), so a read that failed while it was away heals without a retry
    /// button. Going offline reads nothing, so what is shown stays. Kept reads revalidate through
    /// their own generations instead.
    func readWhenConnected<ID: Equatable>(_ model: ClientModel, id: ID, _ read: @escaping @MainActor () async -> Void) -> some View {
        task(id: ConnectedReadKey(id: id, reconnects: model.reads.reconnects)) { await read() }
    }
    func readWhenConnected(_ model: ClientModel, _ read: @escaping @MainActor () async -> Void) -> some View {
        readWhenConnected(model, id: 0, read)
    }
}

private struct ConnectedReadKey<ID: Equatable>: Equatable {
    let id: ID
    let reconnects: Int
}
