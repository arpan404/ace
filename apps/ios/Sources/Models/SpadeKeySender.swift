import Observation

/// The person's keys to the bot's terminal, one write at a time, in order. Each write goes only
/// while this page's stream still follows the terminal and the person may act, checked right
/// before it goes, so a Return queued behind a slow write never runs after the page closed or
/// the computer changed hands: the queue is dropped instead.
@MainActor @Observable final class SpadeKeySender {
    typealias Send = @MainActor ([TerminalInput]) async -> String?
    @ObservationIgnored private var queue = TerminalSendQueue()
    /// The stream the keys belong to, while the page follows it.
    private(set) var stream: String?
    /// Whether keys for `stream` may go now.
    @ObservationIgnored private let allowed: @MainActor (String) -> Bool
    @ObservationIgnored private let permission: @MainActor () -> Int
    @ObservationIgnored private let send: Send
    /// What the last write met, nil once one went.
    private(set) var problem: String?

    init(allowed: @escaping @MainActor (String) -> Bool, permission: @escaping @MainActor () -> Int,
         send: @escaping Send) {
        self.allowed = allowed
        self.permission = permission
        self.send = send
    }

    func start(_ stream: String) { queue.reset(); self.stream = stream }
    func stop() { queue.reset(); stream = nil }

    @discardableResult
    func type(_ input: [TerminalInput]) -> Task<Void, Never>? {
        guard let stream, allowed(stream), let batch = queue.add(input) else { return nil }
        let granted = permission()
        return Task { await go(batch, for: stream, granted: granted) }
    }

    private func go(_ batch: [TerminalInput], for owner: String, granted: Int) async {
        var next: [TerminalInput]? = batch
        while let batch = next {
            guard stream == owner, allowed(owner), permission() == granted else {
                if stream == owner { queue.reset() }
                return
            }
            let result = await send(batch)
            guard stream == owner else { return }
            problem = result
            next = queue.finished()
        }
    }
}
