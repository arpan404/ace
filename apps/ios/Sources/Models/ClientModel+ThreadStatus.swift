import Foundation

extension ClientModel {
    /// The status the open thread's header shows. The inbox row is the confirmed authority and
    /// reads Syncing until confirmed; without one, only metadata from this visit may speak, so a
    /// reopened thread never shows the Done it was left at while it works again elsewhere.
    func headerStatus(of thread: ThreadModel) -> StatusDisplay? {
        if let row = inbox[thread.id] {
            return StatusDisplay(label: ThreadLiveActivity.displayLabel(row: row, online: true),
                                 token: ThreadLiveActivity.displayToken(row: row, online: true))
        }
        guard let metadata = thread.metadata else { return nil }
        return thread.metadataCurrent ? metadata.status : StatusDisplay(label: "Syncing", token: "neutral")
    }
}
