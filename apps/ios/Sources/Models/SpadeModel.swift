import Foundation
import Observation

/// Spade on one machine (`bridge/spade.ts`, ADR 0127): its state line, its roster of bots and the
/// one bot's conversation open on the phone, as the bridge last put them. The words and every
/// decision are the bridge's (shared `@ace/ui-core/spade-chat`); the screens only draw them.
@MainActor @Observable final class SpadeModel {
    /// What the Spade place says about Spade, and whether it offers Turn on.
    struct Line: Decodable, Equatable, Sendable {
        let sentence: String
        let ready: Bool
        let canTurnOn: Bool
    }
    /// A bot's face: the Spade mark, an uploaded picture (read with `spade.image`), or initials.
    struct Face: Decodable, Equatable, Sendable {
        /// `spade`, `image` or `generated`.
        let kind: String
        let sha256: String?
        let initials: String?
        /// `#RRGGBB`, the shared avatar fill behind the initials.
        let fill: String?
    }
    /// A bot in the roster: its face and name, when it was last active, and what it does now.
    struct Bot: Decodable, Equatable, Sendable, Identifiable {
        let id: String
        let conversation: String
        /// Spade itself, the main bot.
        let main: Bool
        let name: String
        let face: Face
        let age: String
        let line: String
        /// `working`, `needs-you`, or nil for a plain latest message.
        let tone: String?
        let working: Bool
    }
    struct State: Decodable, Equatable, Sendable {
        struct Roster: Decodable, Equatable, Sendable {
            /// Nil until the roster is first read.
            let rows: [Bot]?
            /// The first read failed; the place says so with Try again.
            let failed: Bool
        }
        let line: Line
        /// While Spade runs but waits on the person (a keychain prompt), what to look for.
        let setup: String?
        let enabled: Bool?
        let roster: Roster
    }
    /// One line under the last bubble while anything is open: the bot's few words, or that it
    /// waits on the person; `moving` while it works itself.
    struct Status: Decodable, Equatable, Sendable {
        let text: String
        let moving: Bool
    }
    struct Conversation: Decodable, Equatable, Sendable {
        let agentId: String
        let loaded: Bool
        let problem: String?
        let busy: Bool
        let status: Status?
    }
    /// Why a reply failed: its sentence, Spade's words for Details, and the words Try again sends.
    struct Failure: Decodable, Equatable, Sendable {
        let sentence: String
        let details: String?
        let retry: String?
    }
    /// One bubble of the conversation.
    enum Bubble: Decodable, Equatable, Sendable {
        case person(text: String, attachments: String?, sending: Bool)
        case bot(text: String, live: Bool, end: String?, failure: Failure?, attachments: String?)
        /// Another bot's message here, under its name.
        case other(name: String, text: String)
        /// A small label in the middle (a routine fired, a group asked), and what it said.
        case label(label: String, text: String?)
        /// One quiet line on the bot's side.
        case note(text: String)
        /// The bot asks to use a tool: Allow, Deny, and for a command Always allow this command.
        case ask(callId: String, sentence: String, reason: String?, command: String?, details: String?)

        private enum Keys: String, CodingKey {
            case kind, text, attachments, sending, live, end, failure, name, label, callId, sentence, reason, command, details
        }
        init(from decoder: any Decoder) throws {
            let box = try decoder.container(keyedBy: Keys.self)
            let text: () throws -> String = { try box.decodeIfPresent(String.self, forKey: .text) ?? "" }
            switch try box.decode(String.self, forKey: .kind) {
            case "person":
                self = .person(text: try text(), attachments: try box.decodeIfPresent(String.self, forKey: .attachments),
                               sending: try box.decodeIfPresent(Bool.self, forKey: .sending) ?? false)
            case "bot":
                self = .bot(text: try text(), live: try box.decodeIfPresent(Bool.self, forKey: .live) ?? false,
                            end: try box.decodeIfPresent(String.self, forKey: .end),
                            failure: try box.decodeIfPresent(Failure.self, forKey: .failure),
                            attachments: try box.decodeIfPresent(String.self, forKey: .attachments))
            case "other":
                self = .other(name: try box.decodeIfPresent(String.self, forKey: .name) ?? "", text: try text())
            case "label":
                self = .label(label: try box.decodeIfPresent(String.self, forKey: .label) ?? "",
                              text: try box.decodeIfPresent(String.self, forKey: .text))
            case "ask":
                self = .ask(callId: try box.decode(String.self, forKey: .callId),
                            sentence: try box.decodeIfPresent(String.self, forKey: .sentence) ?? "",
                            reason: try box.decodeIfPresent(String.self, forKey: .reason),
                            command: try box.decodeIfPresent(String.self, forKey: .command),
                            details: try box.decodeIfPresent(String.self, forKey: .details))
            default:
                self = .note(text: try text())
            }
        }

        /// The bot's side of the chat: its face sits by the last of a run of these.
        var botSide: Bool {
            switch self {
            case .bot, .ask, .note: true
            default: false
            }
        }
    }

    /// The bridge's Spade patches.
    enum Patch: Equatable, Sendable {
        case state(State)
        case conversation(Conversation?)
        case order(agentId: String, keys: [String])
        case bubble(agentId: String, key: String, row: Bubble)

        static let types: Set<String> = ["spade.state", "spade.conversation", "spade.conversation.closed", "spade.order", "spade.bubble"]
        private enum Keys: String, CodingKey { case type, agentId, order, key, row }
        init(type: String, from decoder: any Decoder) throws {
            let box = try decoder.container(keyedBy: Keys.self)
            switch type {
            case "spade.state": self = .state(try State(from: decoder))
            case "spade.conversation": self = .conversation(try Conversation(from: decoder))
            case "spade.order":
                self = .order(agentId: try box.decode(String.self, forKey: .agentId), keys: try box.decode([String].self, forKey: .order))
            case "spade.bubble":
                self = .bubble(agentId: try box.decode(String.self, forKey: .agentId),
                               key: try box.decode(String.self, forKey: .key), row: try box.decode(Bubble.self, forKey: .row))
            default: self = .conversation(nil)
            }
        }
    }

    private(set) var line: Line?
    private(set) var setup: String?
    private(set) var enabled: Bool?
    private(set) var bots: [Bot]?
    private(set) var rosterFailed = false
    /// The open conversation, once the bridge has put it.
    private(set) var conversation: Conversation?
    /// The open conversation's bubbles, in order.
    private(set) var order: [String] = []
    private(set) var bubbles: [String: Bubble] = [:]
    /// The bot `order` and `bubbles` belong to.
    private var bubblesOf: String?
    /// Uploaded faces read so far, by hash.
    var faces: [String: Data] = [:]

    /// Places on screen that watch Spade, and the bot they follow: sent again to a new runtime
    /// (`ClientModel.spadeResume`).
    var watchers = 0
    var opened: Opened?

    /// The bot whose conversation a page follows.
    struct Opened: Hashable, Sendable {
        let agentId: String
        let conversationId: String
    }

    /// A bot of the roster, by its id.
    func bot(_ id: String) -> Bot? { bots?.first { $0.id == id } }

    func apply(_ patch: Patch) {
        switch patch {
        case .state(let next):
            if line != next.line { line = next.line }
            if setup != next.setup { setup = next.setup }
            if enabled != next.enabled { enabled = next.enabled }
            if bots != next.roster.rows, let fresh = next.roster.rows { bots = fresh }
            if rosterFailed != next.roster.failed { rosterFailed = next.roster.failed }
        case .conversation(let next):
            belong(to: next?.agentId)
            if conversation != next { conversation = next }
        case .order(let id, let keys):
            belong(to: id)
            if order != keys { order = keys }
        case .bubble(let id, let key, let row):
            belong(to: id)
            if bubbles[key] != row { bubbles[key] = row }
        }
    }

    /// Another bot's bubbles begin: the last one's go.
    private func belong(to id: String?) {
        guard bubblesOf != id else { return }
        bubblesOf = id
        order = []
        bubbles = [:]
        if conversation?.agentId != id { conversation = nil }
    }

    /// Another machine's runtime: nothing of this one's Spade applies.
    func reset() {
        line = nil; setup = nil; enabled = nil; bots = nil; rosterFailed = false; faces = [:]
        belong(to: nil)
    }
}

/// The composer's words around a send that Spade refused.
enum SpadeDraft {
    /// `draft` once the refused `message` comes back: the refused words first, then whatever was
    /// typed while it was out, so neither is lost.
    static func restoring(_ message: String, into draft: String) -> String {
        let typed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if typed.isEmpty { return message }
        if typed == message { return draft }
        return "\(message)\n\n\(draft)"
    }

    /// The composer once a send of `sent` ends: as it is when it went; otherwise the words come
    /// back (`restoring`) with why it failed.
    static func after(_ outcome: SpadeOutcome, sent: String, draft: String) -> (draft: String, problem: String?) {
        guard !outcome.ok else { return (draft, nil) }
        return (restoring(sent, into: draft), outcome.words)
    }
}
