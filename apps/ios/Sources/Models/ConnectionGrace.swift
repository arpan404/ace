import Foundation

/// The connection state the screens show for one machine, from the runtime's real state and the
/// time. A connection that was ready and is now being replaced (a Wi-Fi to cellular change, a
/// socket that died while the app was suspended, a move between the relay and the direct
/// route) keeps reading as connected for `grace`, so a reconnect that succeeds quickly is never
/// seen. Past the grace the real state shows. A refusal (`fatal`) shows at once.
///
/// Only the words and the dot read this. Everything that acts on the connection (sends, reads,
/// confirming a row as done) keeps reading the real state, so nothing is settled from stale
/// data while the grace hides a reconnect (AGENTS.md priority 1). Pure: times are ms on a
/// monotonic clock, so a wall clock set back or forward never stretches or cuts the grace.
struct ConnectionGrace: Equatable, Sendable {
    /// How long a reconnect stays out of sight (ms).
    static let grace: Double = 6_000
    /// What the runtime really reports.
    private(set) var actual: String
    /// What the screens show.
    private(set) var shown: String
    /// When the real state left ready while the screens still show it.
    private(set) var hiddenSince: Double?

    init(_ state: String = "connecting") { actual = state; shown = state }

    /// The runtime's state changed. Returns when the shown state must be looked at again
    /// (`elapsed`), while a reconnect is hidden.
    mutating func changed(_ state: String, at now: Double) -> Double? {
        actual = state
        return settle(at: now)
    }

    /// Time passed: a hidden reconnect that ran past the grace shows. Returns when to look again
    /// while it is still hidden, as a timer that woke early does.
    @discardableResult mutating func elapsed(at now: Double) -> Double? { settle(at: now) }

    private mutating func settle(at now: Double) -> Double? {
        if actual == "ready" || actual == "fatal" || shown != "ready" {
            hiddenSince = nil
            shown = actual
            return nil
        }
        let since = hiddenSince ?? now
        hiddenSince = since
        guard now < since + Self.grace else {
            hiddenSince = nil
            shown = actual
            return nil
        }
        return since + Self.grace
    }
}
