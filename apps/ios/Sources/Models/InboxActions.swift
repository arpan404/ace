import Foundation

/// Inbox organization. Each command goes through the SDK's durable outbox; the Bool says it was
/// admitted on this device, and the daemon's canonical list update moves the row.
extension ClientModel {
    func archive(_ threadId: String) async -> Bool { await inboxCommand(["kind": "archive", "threadId": threadId]) }
    func unarchive(_ threadId: String) async -> Bool { await inboxCommand(["kind": "unarchive", "threadId": threadId]) }
    /// Moves the thread to Settled; the daemon refuses while its tree still runs.
    func settle(_ threadId: String) async -> Bool { await inboxCommand(["kind": "settle", "threadId": threadId]) }
    func unsettle(_ threadId: String) async -> Bool { await inboxCommand(["kind": "unsettle", "threadId": threadId]) }
    /// Snoozes until a time or an event (`bridge/inbox-snooze.ts`): `choice` is a preset id from
    /// `inboxLayout.snooze` or one of the row's `snoozeEvents`. Answers once saved on this device,
    /// with the toast's words and what Undo puts back; nil when this phone can't ask.
    func snooze(_ threadId: String, choice: String) async -> SnoozeAnswer? {
        guard canOperate else { return nil }
        return try? await service(["type": "inbox.snooze", "threadId": threadId, "choice": choice], as: SnoozeAnswer.self)
    }
    func wake(_ threadId: String) async -> Bool { await inboxCommand(["kind": "wake", "threadId": threadId]) }
    /// Pins (leading Pinned) or unpins; the row moves at once and goes back if refused.
    func pin(_ threadId: String, _ pinned: Bool) async -> Bool {
        await inboxCommand(["kind": "pin", "threadId": threadId, "pinned": pinned])
    }
    func loadOlderThreads() { inboxRequest(["kind": "more"]) }
    /// The Chats tab's search: the runtime narrows its chats by title; empty lists them all.
    func searchChats(_ query: String) { inboxRequest(["kind": "chatsQuery", "query": query]) }
    /// A failed send the person took back into the composer or discarded: it leaves the transcript
    /// and Unsent on this phone. `restoreSend` is Undo.
    func dismissSend(_ commandId: String) async -> Bool { await inboxCommand(["kind": "dismissSend", "commandId": commandId]) }
    func restoreSend(_ commandId: String) async -> Bool { await inboxCommand(["kind": "restoreSend", "commandId": commandId]) }
    /// Marks the thread unread (its row reads Done again) or read.
    func markUnread(_ threadId: String, _ unread: Bool) async -> Bool {
        await inboxCommand(["kind": "read", "threadId": threadId, "unread": unread])
    }
    /// Off, the thread stays until settled by hand; on, it settles by itself again.
    func setAutoSettle(_ threadId: String, _ enabled: Bool) async -> Bool {
        await inboxCommand(["kind": "autoSettle", "threadId": threadId, "enabled": enabled])
    }
    /// Puts a snooze back as it was, with the event it waited for (Undo of a snooze or a settle),
    /// or wakes the thread (`until` nil). Resolves with nil once the machine took it (one it finds
    /// already over wakes the thread instead), else its refusal in words.
    func snooze(_ threadId: String, until: Double?, wake: String?) async -> String? {
        guard canOperate else { return "This phone can only view this machine." }
        let id = admissions.nextId()
        let back: [String: Any] = ["kind": "snoozeAt", "threadId": threadId, "until": until.map { $0 as Any } ?? NSNull(),
                                   "wake": wake.map { $0 as Any } ?? NSNull()]
        return await receipts.wait(id: id) { action(["type": "inbox", "action": back, "requestId": id]) }
    }
    /// Moves the thread to another of this machine's projects; the row moves at once.
    func moveThread(_ threadId: String, to workspaceId: String) async -> Bool {
        await inboxCommand(["kind": "move", "threadId": threadId, "workspaceId": workspaceId])
    }
    /// One action on several of this machine's threads, or a delete (`bridge/inbox-manage.ts`):
    /// answers once each is saved and the machine has answered, or a few seconds after saving.
    func bulk(_ action: BulkAction, _ threadIds: [String], workspaceId: String? = nil, force: Bool = false, ticket: String? = nil) async -> BulkOutcome {
        guard canOperate else { return BulkOutcome(refused: threadIds.map { .init(threadId: $0, message: "This phone can only view this machine.") }) }
        var request: [String: Any] = ["type": "inbox.bulk", "action": action.rawValue, "threadIds": threadIds]
        if let workspaceId { request["workspaceId"] = workspaceId }
        if force { request["force"] = true }
        if let ticket { request["ticket"] = ticket }
        do { return try await service(request, as: BulkOutcome.self) }
        catch { return BulkOutcome(refused: threadIds.map { .init(threadId: $0, message: error.localizedDescription) }) }
    }
    /// The question asked before deleting `threadIds` for good, from their listed state.
    func deleteQuestion(_ threadIds: [String]) async -> DeleteQuestion? {
        try? await service(["type": "inbox.deleteQuestion", "threadIds": threadIds], as: DeleteQuestion.self)
    }
}

/// A snooze as Undo puts it back: when it ends (nil: the thread wakes) and the event it waits
/// for ("needs_you", "pr").
struct SnoozeBack: Codable, Sendable, Equatable {
    let until: Double?
    let wake: String?
}

/// The bridge's answer to a snooze (`SnoozeAnswer` in `bridge/inbox-snooze.ts`).
struct SnoozeAnswer: Decodable, Sendable, Equatable {
    /// Saved on this device; the machine's refusal, if any, comes later as the screen's error.
    let saved: Bool
    /// Why it wasn't saved; empty when it was.
    let message: String
    /// "Snoozed until it needs you · Fix login", beside Undo.
    let toast: String
    let undo: SnoozeBack
}

/// One Snooze menu choice: a time preset from the layout, or an event the row offers.
struct SnoozeChoice: Identifiable, Equatable {
    let id: String
    let label: String
    /// What brings the thread back, under an event's label.
    var detail: String? = nil

    /// The web's Snooze menu, top to bottom: Until it needs you, the times, Until the PR changes.
    static func menu(presets: [InboxLayout.SnoozeOption], events: [ThreadRow.SnoozeEvent]) -> [SnoozeChoice] {
        let event = { (item: ThreadRow.SnoozeEvent) in SnoozeChoice(id: item.id, label: item.label, detail: item.detail) }
        let times = presets.map { SnoozeChoice(id: $0.id, label: $0.label) }
        return events.filter { $0.id == "needs_you" }.map(event) + times + events.filter { $0.id != "needs_you" }.map(event)
    }
}

/// What `ClientModel.bulk` does to each thread (`InboxBulkRequest`).
enum BulkAction: String, Sendable {
    case pin, unpin, settle, unsettle, undoSettle, archive, unarchive, read, unread, move, delete
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
    /// The question to ask again for `running`.
    var retry: DeleteQuestion? = nil
}

/// The shared delete question (`deleteQuestion` in `@ace/ui-core`).
struct DeleteQuestion: Decodable, Sendable, Equatable {
    let title: String
    let message: String
    let running: String
    let confirm: String
    let force: Bool
}
