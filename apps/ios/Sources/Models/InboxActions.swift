import Foundation

/// Inbox organization. Each command goes through the SDK's durable outbox; the Bool says it was
/// admitted on this device, and the daemon's canonical list update moves the row.
extension ClientModel {
    func archive(_ threadId: String) async -> Bool { await inboxCommand(["kind": "archive", "threadId": threadId]) }
    func unarchive(_ threadId: String) async -> Bool { await inboxCommand(["kind": "unarchive", "threadId": threadId]) }
    /// Moves the thread to Settled; the daemon refuses while its tree still runs.
    func settle(_ threadId: String) async -> Bool { await inboxCommand(["kind": "settle", "threadId": threadId]) }
    func unsettle(_ threadId: String) async -> Bool { await inboxCommand(["kind": "unsettle", "threadId": threadId]) }
    /// `preset` is a shared snooze preset id from `inboxLayout.snooze`; the bridge resolves the time.
    func snooze(_ threadId: String, preset: String) async -> Bool {
        await inboxCommand(["kind": "snooze", "threadId": threadId, "preset": preset])
    }
    func wake(_ threadId: String) async -> Bool { await inboxCommand(["kind": "wake", "threadId": threadId]) }
    /// Pins (leading Pinned) or unpins; the row moves at once and goes back if refused.
    func pin(_ threadId: String, _ pinned: Bool) async -> Bool {
        await inboxCommand(["kind": "pin", "threadId": threadId, "pinned": pinned])
    }
    func loadOlderThreads() { inboxRequest(["kind": "more"]) }
    /// A failed send the person took back into the composer or discarded: it leaves the transcript
    /// and Unsent on this phone. `restoreSend` is Undo.
    func dismissSend(_ commandId: String) async -> Bool { await inboxCommand(["kind": "dismissSend", "commandId": commandId]) }
    func restoreSend(_ commandId: String) async -> Bool { await inboxCommand(["kind": "restoreSend", "commandId": commandId]) }
}
