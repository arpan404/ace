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
    /// Marks the thread unread (its row reads Done again) or read.
    func markUnread(_ threadId: String, _ unread: Bool) async -> Bool {
        await inboxCommand(["kind": "read", "threadId": threadId, "unread": unread])
    }
    /// Off, the thread stays until settled by hand; on, it settles by itself again.
    func setAutoSettle(_ threadId: String, _ enabled: Bool) async -> Bool {
        await inboxCommand(["kind": "autoSettle", "threadId": threadId, "enabled": enabled])
    }
    /// Moves the thread to another of this machine's projects; the row moves at once.
    func moveThread(_ threadId: String, to workspaceId: String) async -> Bool {
        await inboxCommand(["kind": "move", "threadId": threadId, "workspaceId": workspaceId])
    }
    /// One action on several of this machine's threads, or a delete (`bridge/inbox-manage.ts`):
    /// answers once each is saved and the machine has answered, or a few seconds after saving.
    func bulk(_ action: BulkAction, _ threadIds: [String], workspaceId: String? = nil, force: Bool = false) async -> BulkOutcome {
        guard canOperate else { return BulkOutcome(refused: threadIds.map { .init(threadId: $0, message: "This phone can only view this machine.") }) }
        var request: [String: Any] = ["type": "inbox.bulk", "action": action.rawValue, "threadIds": threadIds]
        if let workspaceId { request["workspaceId"] = workspaceId }
        if force { request["force"] = true }
        do { return try await service(request, as: BulkOutcome.self) }
        catch { return BulkOutcome(refused: threadIds.map { .init(threadId: $0, message: error.localizedDescription) }) }
    }
    /// The question asked before deleting `threadIds` for good, from their listed state.
    func deleteQuestion(_ threadIds: [String]) async -> DeleteQuestion? {
        try? await service(["type": "inbox.deleteQuestion", "threadIds": threadIds], as: DeleteQuestion.self)
    }
}

/// What `ClientModel.bulk` does to each thread (`InboxBulkRequest`).
enum BulkAction: String, Sendable {
    case pin, unpin, settle, unsettle, archive, unarchive, read, unread, move, delete
}

/// The machine's answer to a bulk action (`BulkOutcome` in `bridge/inbox-manage.ts`).
struct BulkOutcome: Decodable, Sendable, Equatable {
    struct Refusal: Decodable, Sendable, Equatable { let threadId: String; let message: String }
    var saved: [String] = []
    var skipped: [String] = []
    var refused: [Refusal] = []
    /// Deletes refused only because agents or terminals still run: offer Stop and delete.
    var running: [String] = []
    var waiting: [String] = []
}

/// The shared delete question (`deleteQuestion` in `@ace/ui-core`).
struct DeleteQuestion: Decodable, Sendable, Equatable {
    let title: String
    let message: String
    let running: String
    let confirm: String
    let force: Bool
}
