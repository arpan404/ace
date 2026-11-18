/// Which machine reads its Spade bots for the tab. A hold names the shown machine's client and
/// whether the tab shows, and stops every other client. Releasing the newest hold stops the client
/// it named, so a tab that goes (Beta's Spade turned off, say) leaves no machine reading. A hold
/// released after a newer one began changes nothing: the newer one owns the watch.
@MainActor final class SpadeWatch {
    private var current = 0
    private weak var held: ClientModel?

    func hold(_ client: ClientModel?, on: Bool, among clients: [ClientModel]) -> Int {
        if let held, held !== client { held.spadeWatch(false) }
        for other in clients where other !== client { other.spadeWatch(false) }
        client?.spadeWatch(on)
        held = client
        current += 1
        return current
    }

    func release(_ hold: Int) {
        guard hold == current else { return }
        held?.spadeWatch(false)
        held = nil
    }
}
