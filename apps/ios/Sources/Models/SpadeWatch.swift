/// Which machines read their Spade bots for the tab: every machine its one list shows, while the
/// tab shows. A hold names those clients and whether the tab shows, and stops every other client
/// and any it held before that it no longer names. Releasing the newest hold stops the clients it
/// named, so a tab that goes (Beta's Spade turned off, say) leaves no machine reading. A hold
/// released after a newer one began changes nothing: the newer one owns the watch.
@MainActor final class SpadeWatch {
    private var current = 0
    private var held: [Weak] = []

    func hold(_ clients: [ClientModel], on: Bool, among all: [ClientModel]) -> Int {
        let named = { (client: ClientModel) in clients.contains { $0 === client } }
        for client in held.compactMap(\.client) where !named(client) { client.spadeWatch(false) }
        for other in all where !named(other) { other.spadeWatch(false) }
        for client in clients { client.spadeWatch(on) }
        held = clients.map { Weak(client: $0) }
        current += 1
        return current
    }

    func release(_ hold: Int) {
        guard hold == current else { return }
        for client in held.compactMap(\.client) { client.spadeWatch(false) }
        held = []
    }

    private struct Weak {
        weak var client: ClientModel?
    }
}
