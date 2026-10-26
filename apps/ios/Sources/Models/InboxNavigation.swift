import SwiftUI

/// Whether the list coming back on top of a compact window (an iPhone) means the person went
/// back, closing the open thread. Two things say so, in either order: the split view reports the
/// list on top, and the list appears. The report alone also comes when a page pushed over the
/// thread (the browser) is popped, and the list alone appears when a window changes shape; only
/// both together close the thread. When the close was missed, the row stayed marked open and a
/// tap on it changed nothing, so the thread couldn't be opened again from its own row.
struct BackToList: Equatable {
    private var reported = false
    private var listShown = false

    /// The split view put the list on top. True when that closes the thread now.
    mutating func listReported(_ sizeClass: UserInterfaceSizeClass?) -> Bool {
        guard sizeClass == .compact else { return false }
        if listShown { reported = false; return true }
        reported = true
        return false
    }
    /// The list appeared. True when that closes the thread now.
    mutating func listAppeared(_ sizeClass: UserInterfaceSizeClass?) -> Bool {
        listShown = true
        defer { reported = false }
        return sizeClass == .compact && reported
    }
    /// A thread covers the list.
    mutating func listDisappeared() {
        listShown = false
        reported = false
    }
}

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
