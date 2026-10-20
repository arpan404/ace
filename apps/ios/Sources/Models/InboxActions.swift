import Foundation

/// Inbox organization. Each command goes through the SDK's durable outbox; the Bool says it was
/// admitted on this device, and the daemon's canonical list update moves the row.
extension ClientModel {
    func archive(_ threadId: String) async -> Bool { await inboxCommand(["kind": "archive", "threadId": threadId]) }
    func unarchive(_ threadId: String) async -> Bool { await inboxCommand(["kind": "unarchive", "threadId": threadId]) }
    /// `preset` is a shared snooze preset id from `inboxLayout.snooze`; the bridge resolves the time.
    func snooze(_ threadId: String, preset: String) async -> Bool {
        await inboxCommand(["kind": "snooze", "threadId": threadId, "preset": preset])
    }
    func wake(_ threadId: String) async -> Bool { await inboxCommand(["kind": "wake", "threadId": threadId]) }
    func loadOlderThreads() { inboxRequest(["kind": "more"]) }
}
