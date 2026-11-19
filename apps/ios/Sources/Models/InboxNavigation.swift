import SwiftUI

/// A row's own action (Settle, Archive, Snooze, Wake) removes or moves it under the finger; the
/// row sliding into its place must not take the same touch as a tap and open another thread.
/// For a moment after an action, row taps open nothing.
struct RowTapGuard: Equatable {
    /// How long after a row action a tap is taken to be part of it, in seconds.
    static let window: TimeInterval = 0.5
    private var actedAt: TimeInterval?

    /// A row action ran at `now` (monotonic seconds).
    mutating func acted(at now: TimeInterval) { actedAt = now }
    /// Whether a row tap at `now` opens its thread.
    func opens(at now: TimeInterval) -> Bool {
        guard let actedAt else { return true }
        return now - actedAt >= Self.window || now < actedAt
    }
}
