import Foundation

/// What a Spade request came to (`bridge/spade-requests.ts`): done, or refused with a title and
/// why, in the person's words.
struct SpadeOutcome: Decodable, Sendable {
    let ok: Bool
    /// A conversation just started: where it is.
    let id: String?
    let title: String?
    let message: String?
    /// Spade may have it: the answer was lost and couldn't be checked. The words stay with the
    /// person under `note` (`spadeStartWords`), never sent again on their own.
    let unknown: Bool?
    let note: String?
    init(ok: Bool, id: String? = nil, title: String? = nil, message: String? = nil, unknown: Bool? = nil, note: String? = nil) {
        self.ok = ok; self.id = id; self.title = title; self.message = message; self.unknown = unknown; self.note = note
    }
}

/// Settings › Spade: each endpoint Spade knows, its key line and its models.
struct SpadeModels: Decodable, Sendable {
    struct KeyLine: Decodable, Equatable, Sendable {
        let description: String
        let canSave: Bool
        let canRemove: Bool
        let placeholder: String
    }
    struct Model: Decodable, Equatable, Sendable, Identifiable {
        let id: String
        let name: String
        let roles: String?
    }
    struct Endpoint: Decodable, Equatable, Sendable, Identifiable {
        let id: String
        let name: String
        /// Nil when the endpoint needs no key.
        let key: KeyLine?
        let models: [Model]
    }
    let ok: Bool
    let endpoints: [Endpoint]?
    let title: String?
    let message: String?
}

extension ClientModel {
    /// A Spade place shows (the tab, Settings › Spade), or no longer does.
    func spadeWatch(_ on: Bool) {
        spade.watchers = max(0, spade.watchers + (on ? 1 : -1))
        action(["type": "spade.watch", "on": on])
    }
    /// Follow `id` live, or no conversation.
    func spadeOpen(_ id: String?) {
        guard spade.opened != id else { return }
        spade.opened = id
        action(["type": "spade.open", "conversationId": id.map { $0 as Any } ?? NSNull()])
    }
    func spadeRetry() { action(["type": "spade.retry"]) }
    /// Read Spade's state, the setting and the list again now.
    func spadeRefresh() { action(["type": "spade.refresh"]) }
    /// A new runtime knows nothing of what shows: tell it again.
    func spadeResume() {
        for _ in 0..<spade.watchers { action(["type": "spade.watch", "on": true]) }
        if let id = spade.opened { action(["type": "spade.open", "conversationId": id]) }
    }
    /// A Spade request; a transport failure reads as a refusal with its words.
    func spadeRequest(_ payload: [String: Any], failing title: String) async -> SpadeOutcome {
        do { return try await service(payload, as: SpadeOutcome.self, timeout: .seconds(70)) }
        catch is CancellationError { return SpadeOutcome(ok: false) }
        catch { return SpadeOutcome(ok: false, title: title, message: error.localizedDescription) }
    }
    func spadeModels() async -> SpadeModels {
        do { return try await service(["type": "spade.models"], as: SpadeModels.self) }
        catch { return SpadeModels(ok: false, endpoints: nil, title: "Couldn't read Spade's models", message: error.localizedDescription) }
    }
}
