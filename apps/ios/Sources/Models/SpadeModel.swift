import Foundation
import Observation

/// Spade on one machine (`bridge/spade.ts`): whether the machine shows it (Settings › Beta), its
/// state line, its bots and the one conversation open on the phone, as the bridge last put them.
/// The words and every decision are the bridge's (shared `@ace/ui-core/spade-chat`); the screens
/// only draw them.
@MainActor @Observable final class SpadeModel {
    /// What the Spade tab says about Spade itself, and whether it offers Turn on.
    struct Line: Decodable, Equatable, Sendable {
        let sentence: String
        let ready: Bool
        let canTurnOn: Bool
    }
    /// A bot in the list: its name, and its state and one line as web's list says them.
    struct Bot: Decodable, Equatable, Sendable, Identifiable {
        let id: String
        let conversation: String
        let name: String
        /// Spade itself: its face is the Spade mark.
        let main: Bool
        let initial: String
        /// `needs-you`, `working`, `failed`, `unseen`, `rest` or `off`.
        let state: String
        let line: String
        let pinned: Bool
    }
    struct State: Decodable, Equatable, Sendable {
        struct List: Decodable, Equatable, Sendable {
            /// Nil until the bots are first read.
            let rows: [Bot]?
            /// The first read failed; the list says so with Try again.
            let failed: Bool
        }
        /// Nil until the daemon first answers.
        let shown: Bool?
        let line: Line
        let list: List
    }
    /// The conversation's Working line.
    struct Working: Decodable, Equatable, Sendable {
        let label: String
        let moving: Bool
    }
    /// "2 questions for later" in the top bar, and the oldest such card it goes to.
    struct Later: Decodable, Equatable, Sendable {
        let words: String
        let callId: String
    }
    struct Conversation: Decodable, Equatable, Sendable {
        let id: String
        let loaded: Bool
        let problem: String?
        /// A reply is open: Stop is offered, and a message steers it.
        let answering: Bool
        let working: Working?
        let later: Later?
    }
    struct End: Decodable, Equatable, Sendable {
        let text: String
        let alert: Bool
    }
    /// One bubble of the conversation.
    enum Bubble: Decodable, Equatable, Sendable {
        case person(text: String, sending: Bool, attached: String?)
        case bot(text: String, live: Bool, end: End?)
        case ask(callId: String, sentence: String, detail: String?, reason: String?, always: Bool)
        case question(SpadeQuestionCard)
        case note(text: String)

        private enum Keys: String, CodingKey { case kind, text, sending, attached, live, end, callId, sentence, detail, reason, always }
        init(from decoder: any Decoder) throws {
            let box = try decoder.container(keyedBy: Keys.self)
            let text = try box.decodeIfPresent(String.self, forKey: .text) ?? ""
            switch try box.decode(String.self, forKey: .kind) {
            case "person":
                self = .person(text: text, sending: try box.decodeIfPresent(Bool.self, forKey: .sending) ?? false,
                               attached: try box.decodeIfPresent(String.self, forKey: .attached))
            case "bot":
                self = .bot(text: text, live: try box.decodeIfPresent(Bool.self, forKey: .live) ?? false,
                            end: try box.decodeIfPresent(End.self, forKey: .end))
            case "ask":
                self = .ask(callId: try box.decode(String.self, forKey: .callId), sentence: try box.decode(String.self, forKey: .sentence),
                            detail: try box.decodeIfPresent(String.self, forKey: .detail),
                            reason: try box.decodeIfPresent(String.self, forKey: .reason),
                            always: try box.decodeIfPresent(Bool.self, forKey: .always) ?? false)
            case "question":
                self = .question(try SpadeQuestionCard(from: decoder))
            default:
                self = .note(text: text)
            }
        }
    }

    /// The bridge's Spade patches.
    enum Patch: Equatable, Sendable {
        case state(State)
        case conversation(Conversation?)
        case order(conversation: String, keys: [String])
        case row(conversation: String, key: String, bubble: Bubble)

        static let types: Set<String> = ["spade.state", "spade.conversation", "spade.conversation.closed", "spade.order", "spade.row"]
        private enum Keys: String, CodingKey { case conversation, order, key, row }
        init(type: String, from decoder: any Decoder) throws {
            let box = try decoder.container(keyedBy: Keys.self)
            switch type {
            case "spade.state": self = .state(try State(from: decoder))
            case "spade.conversation": self = .conversation(try Conversation(from: decoder))
            case "spade.order":
                self = .order(conversation: try box.decode(String.self, forKey: .conversation), keys: try box.decode([String].self, forKey: .order))
            case "spade.row":
                self = .row(conversation: try box.decode(String.self, forKey: .conversation),
                            key: try box.decode(String.self, forKey: .key), bubble: try box.decode(Bubble.self, forKey: .row))
            default: self = .conversation(nil)
            }
        }
    }

    /// Whether the machine shows Spade: nil until its daemon first says.
    private(set) var shown: Bool?
    private(set) var line: Line?
    private(set) var bots: [Bot]?
    private(set) var listFailed = false
    /// The open conversation, once the bridge has put it.
    private(set) var conversation: Conversation?
    /// The open conversation's bubbles, in order.
    private(set) var order: [String] = []
    private(set) var bubbles: [String: Bubble] = [:]
    /// The conversation `order` and `bubbles` belong to.
    private var bubblesOf: String?

    /// Whether the Spade tab shows, and the conversation it follows: sent again to a new
    /// runtime (`ClientModel.spadeResume`).
    var watching = false
    var opened: String?

    func apply(_ patch: Patch) {
        switch patch {
        case .state(let next):
            if let fresh = next.shown, shown != fresh { shown = fresh }
            if line != next.line { line = next.line }
            if let fresh = next.list.rows, bots != fresh { bots = fresh }
            if listFailed != next.list.failed { listFailed = next.list.failed }
        case .conversation(let next):
            belong(to: next?.id)
            if conversation != next { conversation = next }
        case .order(let id, let keys):
            belong(to: id)
            if order != keys { order = keys }
        case .row(let id, let key, let bubble):
            belong(to: id)
            if bubbles[key] != bubble { bubbles[key] = bubble }
        }
    }

    /// Another conversation's bubbles begin: the last one's go.
    private func belong(to id: String?) {
        guard bubblesOf != id else { return }
        bubblesOf = id
        order = []
        bubbles = [:]
        if conversation?.id != id { conversation = nil }
    }

    /// Another machine's runtime: nothing of this one's Spade applies.
    func reset() {
        shown = nil; line = nil; bots = nil; listFailed = false
        belong(to: nil)
    }
}

/// What a Spade request came to (`bridge/spade-requests.ts`): done, or refused with a title and
/// why, in the person's words.
struct SpadeOutcome: Decodable, Sendable {
    let ok: Bool
    let title: String?
    let message: String?
    /// A card of questions: the question that needs more, by its place in the card.
    let at: Int?
    init(ok: Bool, title: String? = nil, message: String? = nil, at: Int? = nil) {
        self.ok = ok; self.title = title; self.message = message; self.at = at
    }
    /// Why it failed, in one line; nil when it went.
    var problem: String? {
        guard !ok else { return nil }
        let said = [title, message].compactMap(\.self).filter { !$0.isEmpty }
        return said.isEmpty ? nil : said.joined(separator: ". ")
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
}
