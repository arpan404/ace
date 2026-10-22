import SwiftUI

extension View {
    /// Runs `read` when the view appears, when `id` changes, and each time `model`'s machine comes
    /// back, so a read that failed while it was away heals without a retry button. Going offline
    /// reads nothing, so what is shown stays.
    func readWhenConnected<ID: Equatable>(_ model: ClientModel, id: ID, _ read: @escaping @MainActor () async -> Void) -> some View {
        task(id: ConnectedReadKey(id: id, readyCount: model.readyCount)) { await read() }
    }
    func readWhenConnected(_ model: ClientModel, _ read: @escaping @MainActor () async -> Void) -> some View {
        readWhenConnected(model, id: 0, read)
    }
}

private struct ConnectedReadKey<ID: Equatable>: Equatable {
    let id: ID
    let readyCount: Int
}
