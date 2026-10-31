import Foundation

extension ClientModel {
    /// The status the open thread's header shows. The inbox row is the confirmed authority and
    /// reads Syncing until confirmed; without one, only metadata from this visit may speak, so a
    /// reopened thread never shows the Done it was left at while it works again elsewhere.
    /// While a replacement snapshot stages (`refresh != nil` or `requiresSnapshot`), a cached
    /// Done is never authoritative: Syncing shows until the matching ready fence commits,
    /// except a confirmed Working inbox row which still publishes promptly.
    func headerStatus(of thread: ThreadModel) -> StatusDisplay? {
        let staging = thread.refresh != nil || thread.requiresSnapshot
        if let row = inbox[thread.id] {
            if staging, row.state == "done" || row.status.token == "done" {
                return StatusDisplay(label: "Syncing", token: "neutral")
            }
            return StatusDisplay(label: ThreadLiveActivity.displayLabel(row: row, online: true),
                                 token: ThreadLiveActivity.displayToken(row: row, online: true))
        }
        guard let metadata = thread.metadata else { return nil }
        return thread.metadataCurrent && !staging ? metadata.status : StatusDisplay(label: "Syncing", token: "neutral")
    }
}
