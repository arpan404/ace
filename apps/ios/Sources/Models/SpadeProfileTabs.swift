import Foundation

/// What a profile tab's read or write answers (`bridge/spade-requests-profile.ts`): what it shows
/// now (`part`), or why Spade refused, in its words.
struct SpadePart<Value: Decodable & Sendable>: Decodable, Sendable {
    let ok: Bool
    let part: Value?
    let title: String?
    let message: String?
    init(ok: Bool, part: Value? = nil, title: String? = nil, message: String? = nil) {
        self.ok = ok; self.part = part; self.title = title; self.message = message
    }
    var problem: String? { SpadeOutcome(ok: ok, title: title, message: message).problem }
}

/// The Permissions tab (`bridge/spade-profile-permissions.ts`): one switch per kind of reach,
/// each the bot's own or the default in Settings › Spade › Security. Nil `part` answers a Spade
/// before Permissions.
struct SpadePermissions: Decodable, Equatable, Sendable {
    struct Row: Decodable, Equatable, Sendable, Identifiable {
        let key: String
        let title: String
        let line: String
        let on: Bool
        /// The bot sets it itself; false follows the default.
        let own: Bool
        var id: String { key }
    }
    let rows: [Row]
}

/// The Work tab (`bridge/spade-profile-work.ts`): the goal and its plan with evidence, the
/// workers, and the choices the bot made for the person.
struct SpadeWork: Decodable, Equatable, Sendable {
    struct Evidence: Decodable, Equatable, Sendable, Hashable {
        /// `output`, `file` or `url`.
        let kind: String
        let words: String
        /// For a command's output: when the reply that ran it began, in ms.
        let at: Double?
    }
    struct Note: Decodable, Equatable, Sendable, Hashable {
        /// `not-yet` or `waiting`.
        let tone: String
        let text: String
    }
    struct Step: Decodable, Equatable, Sendable, Hashable {
        let text: String
        let depth: Int
        /// `verified`, `claimed`, `working`, `waiting` or `open`.
        let mark: String
        let note: Note?
        let evidence: [Evidence]
    }
    struct Criterion: Decodable, Equatable, Sendable, Hashable {
        let text: String
        let met: Bool
        let why: String?
    }
    struct Goal: Decodable, Equatable, Sendable {
        let title: String
        let text: String
        let heading: String
        let done: Bool
        let criteria: [Criterion]
        let note: String?
        let plan: [Step]
        let more: Int
    }
    struct Worker: Decodable, Equatable, Sendable, Identifiable {
        let id: String
        let name: String
        /// `bot`, `helper` or `ace`.
        let kind: String
        let depth: Int
        let line: String
        /// `needs-you`, `working`, `failed` or `rest`.
        let tone: String
        let spend: String?
        let conversation: String?
        let thread: String?
    }
    struct Decision: Decodable, Equatable, Sendable, Identifiable {
        let id: String
        let choice: String
        let reason: String
        /// When it was stored, in ms.
        let at: Double
        /// The words Change puts in the composer.
        let quote: String
    }
    let goal: Goal?
    let workers: [Worker]
    let spend: String?
    let decisions: [Decision]
    /// The bot works: the tab reads again sooner.
    let moving: Bool

    var empty: Bool { goal == nil && workers.isEmpty && decisions.isEmpty }
}

/// The words the composer holds once a decision's Change quotes it: the quote, then whatever
/// the person had typed, so nothing they wrote is lost.
enum SpadeQuote {
    static func into(_ draft: String, quote: String) -> String {
        let typed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return typed.isEmpty ? "\(quote)\n\n" : "\(quote)\n\n\(typed)"
    }
}
