import Foundation

/// One machine's hook into the lock screen. There is one Live Activity for all of the person's
/// agents (`LockScreenHub`); each machine's `ClientModel` tells it here when its inbox or
/// connection changed, and the thread menu's "Show on Lock Screen" asks for it. The notification
/// coordinator wires both when the machine attaches.
///
/// The row rules that keep a cached copy from reading as current stay here: ClientModel is the
/// single generation authority and applies them to every row.
@MainActor final class ThreadLiveActivity {
    /// Set by the notification coordinator for the machine it attached.
    var onChange: (@MainActor () -> Void)?
    var onShow: (@MainActor () throws -> Void)?

    private let now: () -> Date
    init(now: @escaping () -> Date) { self.now = now }

    /// The thread menu's "Show on Lock Screen": shows the agents activity now.
    func start(row: ThreadRow, hostId: String, online: Bool) throws {
        guard let onShow else { throw ServiceFailure(message: "Live Activities aren't available yet. Try again in a moment.") }
        try onShow()
    }
    /// This machine's inbox or connection changed. `row` stays in the signature for callers.
    func update(row: (String) -> ThreadRow?, hostId: String, online: Bool) { onChange?() }

    /// Older generations (and missing ones) read as unconfirmed: ClientModel, the single
    /// generation authority, normalizes its rows before updates and ticks, so a ready
    /// connection before its row frames never finishes on a cached confirmation.
    nonisolated static func effectiveRow(_ row: ThreadRow, latestGeneration: Int) -> ThreadRow {
        if row.generation == latestGeneration { return row }
        var stale = row
        stale.confirmed = nil
        return stale
    }
    /// A row's status word: the daemon's once confirmed, Syncing while a connected row is still
    /// a cached copy.
    nonisolated static func displayLabel(row: ThreadRow, online: Bool) -> String {
        if online && row.confirmed != true { return "Syncing" }
        return row.status.label
    }
    nonisolated static func displayToken(row: ThreadRow, online: Bool) -> String {
        if online && row.confirmed != true { return "neutral" }
        return row.status.token
    }
}
