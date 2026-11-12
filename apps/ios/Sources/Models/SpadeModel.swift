import Foundation
import Observation

/// Spade on one machine (`bridge/spade.ts`): its state line, its conversation list and the one
/// conversation open on the phone, as the bridge last put them. The words and every decision are
/// the bridge's (shared `@ace/ui-core/spade-chat`); the screens only draw them.
@MainActor @Observable final class SpadeModel {
    /// What the Spade place says about Spade, and whether it offers Turn on.
    struct Line: Decodable, Equatable, Sendable {
        let sentence: String
        let ready: Bool
        let canTurnOn: Bool
    }
    /// A conversation in the list: its name, and Approve, Working or its age.
    struct ListRow: Decodable, Equatable, Sendable, Identifiable {
        let id: String
        let title: String
        /// `needs-you`, `working` or `idle`.
        let tone: String
        let label: String
    }
    struct State: Decodable, Equatable, Sendable {
        struct List: Decodable, Equatable, Sendable {
            /// Nil until the list is first read.
            let rows: [ListRow]?
            /// The first read failed; the list says so with Try again.
            let failed: Bool
        }
        let line: Line
        let enabled: Bool?
        let list: List
    }
    /// The conversation's Working line; `since` in ms since 1970, nil for a background job.
    struct Working: Decodable, Equatable, Sendable {
        let label: String
        let since: Double?
        let moving: Bool
    }
    /// The oldest approval Spade waits on.
    struct Approval: Decodable, Equatable, Sendable {
        let callId: String
        let sentence: String
        let more: Int
        let details: String?
    }
    struct Conversation: Decodable, Equatable, Sendable {
        let id: String
        let title: String
        let loaded: Bool
        let problem: String?
        let busy: Bool
        let answering: Bool
        let working: Working?
        let approval: Approval?
    }
    /// Spade's words (markdown) or the quiet line of a call it made.
    struct Part: Decodable, Equatable, Sendable, Identifiable {
        let key: String
        /// `text` or `line`.
        let kind: String
        let text: String
        let failed: Bool
        var id: String { key }
    }
    struct End: Decodable, Equatable, Sendable {
        let text: String
        let alert: Bool
    }
    /// One entry of the transcript.
    enum Row: Decodable, Equatable, Sendable {
        case user(text: String, images: String?, pending: Bool)
        case reply(parts: [Part], live: String, end: End?)
        case note(text: String, centred: Bool)

        private enum Keys: String, CodingKey { case kind, text, images, pending, parts, live, end, centred }
        init(from decoder: any Decoder) throws {
            let box = try decoder.container(keyedBy: Keys.self)
            switch try box.decode(String.self, forKey: .kind) {
            case "user":
                self = .user(text: try box.decode(String.self, forKey: .text),
                             images: try box.decodeIfPresent(String.self, forKey: .images),
                             pending: try box.decodeIfPresent(Bool.self, forKey: .pending) ?? false)
            case "reply":
                self = .reply(parts: try box.decode([Part].self, forKey: .parts),
                              live: try box.decodeIfPresent(String.self, forKey: .live) ?? "",
                              end: try box.decodeIfPresent(End.self, forKey: .end))
            default:
                self = .note(text: try box.decodeIfPresent(String.self, forKey: .text) ?? "",
                             centred: try box.decodeIfPresent(Bool.self, forKey: .centred) ?? false)
            }
        }
    }

    /// The bridge's Spade patches.
    enum Patch: Equatable, Sendable {
        case state(State)
        case conversation(Conversation?)
        case order(conversation: String, keys: [String])
        case entry(conversation: String, key: String, row: Row)

        static let types: Set<String> = ["spade.state", "spade.conversation", "spade.conversation.closed", "spade.order", "spade.entry"]
        private enum Keys: String, CodingKey { case type, conversation, order, key, row }
        init(type: String, from decoder: any Decoder) throws {
            let box = try decoder.container(keyedBy: Keys.self)
            switch type {
            case "spade.state": self = .state(try State(from: decoder))
            case "spade.conversation": self = .conversation(try Conversation(from: decoder))
            case "spade.order":
                self = .order(conversation: try box.decode(String.self, forKey: .conversation), keys: try box.decode([String].self, forKey: .order))
            case "spade.entry":
                self = .entry(conversation: try box.decode(String.self, forKey: .conversation),
                              key: try box.decode(String.self, forKey: .key), row: try box.decode(Row.self, forKey: .row))
            default: self = .conversation(nil)
            }
        }
    }

    private(set) var line: Line?
    private(set) var enabled: Bool?
    private(set) var rows: [ListRow]?
    private(set) var listFailed = false
    /// The open conversation, once the bridge has put it.
    private(set) var conversation: Conversation?
    /// The open conversation's entries, in order.
    private(set) var order: [String] = []
    private(set) var entries: [String: Row] = [:]
    /// The conversation `order` and `entries` belong to.
    private var entriesOf: String?

    /// Places on screen that watch Spade, and the conversation they follow: sent again to a new
    /// runtime (`ClientModel.spadeResume`).
    var watchers = 0
    var opened: String?

    func apply(_ patch: Patch) {
        switch patch {
        case .state(let next):
            if line != next.line { line = next.line }
            if enabled != next.enabled { enabled = next.enabled }
            if rows != next.list.rows, let fresh = next.list.rows { rows = fresh }
            if listFailed != next.list.failed { listFailed = next.list.failed }
        case .conversation(let next):
            if let next { belong(to: next.id) } else { belong(to: nil) }
            if conversation != next { conversation = next }
        case .order(let id, let keys):
            belong(to: id)
            if order != keys { order = keys }
        case .entry(let id, let key, let row):
            belong(to: id)
            if entries[key] != row { entries[key] = row }
        }
    }

    /// Another conversation's entries begin: the last one's go.
    private func belong(to id: String?) {
        guard entriesOf != id else { return }
        entriesOf = id
        order = []
        entries = [:]
        if conversation?.id != id { conversation = nil }
    }

    /// Another machine's runtime: nothing of this one's Spade applies.
    func reset() {
        line = nil; enabled = nil; rows = nil; listFailed = false
        belong(to: nil)
    }
}
