import Foundation

/// A bot's profile as the bridge reads it (`bridge/spade-profile.ts`): Details, Library and
/// Computer. Each list is a preview: its first items and how many more stay on the computer, or
/// that Spade couldn't read it, which the sheet says with Try again. A list that doesn't apply to
/// this bot (About you, for any bot but Spade) is nil.
struct SpadeProfile: Decodable, Equatable, Sendable {
    /// One list: `{items, more}`, or `{failed: true}`.
    struct Part<Item: Decodable & Equatable & Sendable & Hashable>: Decodable, Equatable, Sendable {
        let items: [Item]
        let more: Int
        let failed: Bool
        private enum Keys: String, CodingKey { case items, more, failed }
        init(from decoder: any Decoder) throws {
            let box = try decoder.container(keyedBy: Keys.self)
            failed = try box.decodeIfPresent(Bool.self, forKey: .failed) ?? false
            items = try box.decodeIfPresent([Item].self, forKey: .items) ?? []
            more = try box.decodeIfPresent(Int.self, forKey: .more) ?? 0
        }
    }
    struct Routine: Decodable, Equatable, Sendable, Hashable {
        let name: String
        let line: String
        let failed: Bool
    }
    struct Details: Decodable, Equatable, Sendable {
        var task: String
        let model: String
        let machine: String
        let routines: Part<Routine>
    }
    struct Page: Decodable, Equatable, Sendable, Hashable {
        let title: String
        let topic: String
    }
    struct File: Decodable, Equatable, Sendable, Hashable {
        let name: String
        let folder: Bool
        /// When it was last written, in ms.
        let at: Double?
    }
    struct Skill: Decodable, Equatable, Sendable, Hashable {
        let name: String
        let word: String
    }
    struct Library: Decodable, Equatable, Sendable {
        /// What every bot knows about the person: Spade's own Library only, nil for a bot.
        let about: Part<String>?
        let notes: Part<String>
        let pages: Part<Page>
        let files: Part<File>
        let skills: Part<Skill>
    }
    struct Surface: Decodable, Equatable, Sendable, Hashable {
        let name: String
        let line: String?
        let live: Bool
    }
    struct Service: Decodable, Equatable, Sendable, Hashable {
        let name: String
        let words: String
        let running: Bool
    }
    struct Computer: Decodable, Equatable, Sendable {
        let line: String
        let surfaces: [Surface]
        let services: Part<Service>
    }

    let id: String
    let name: String
    let face: SpadeModel.Face
    var details: Details
    let library: Library
    let computer: Computer
}

/// What `spade.profile` answers: the profile, or why it couldn't be read.
struct SpadeProfileAnswer: Decodable, Sendable {
    let ok: Bool
    let profile: SpadeProfile?
    let title: String?
    let message: String?
    var problem: String? {
        SpadeOutcome(ok: ok, title: title, message: message).problem
    }
}

/// The profile on the sheet as its reads and the task's saves leave it. Each read takes a ticket;
/// one that comes back after a newer read or a save began is dropped, so a read that was already
/// out when the task was saved can't put the old task back.
struct SpadeProfileReads: Equatable {
    private(set) var profile: SpadeProfile?
    private(set) var problem: String?
    private var generation = 0

    /// A read begins: the ticket it comes back with.
    mutating func begin() -> Int {
        generation += 1
        return generation
    }
    /// A read came back. A failed one keeps the profile already shown and says so only while
    /// there is none.
    mutating func land(_ answer: SpadeProfileAnswer, ticket: Int) {
        guard ticket == generation else { return }
        if let fresh = answer.profile {
            profile = fresh
            problem = nil
        } else if profile == nil {
            problem = answer.problem ?? "Couldn't read the profile."
        }
    }
    /// The task was saved as `task`: it shows now, whatever reads are still out.
    mutating func saved(task: String) {
        generation += 1
        profile?.details.task = task
    }
}

/// The task's Save on its own page: the words it sent stay put while the write is out, a second
/// Save can't go while one is, and a write that went keeps Save locked until the page closes.
struct SpadeTaskSave: Equatable {
    /// The words sent, while the write is out or after it went.
    private(set) var sent: String?
    /// Save is out or done: the field and Save wait.
    var locked: Bool { sent != nil }

    /// The words to send for `text`, or nil when nothing changed against `task` or a save is
    /// already out.
    mutating func begin(_ text: String, task: String) -> String? {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard sent == nil, words != task.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
        sent = words
        return words
    }
    /// Spade refused it: the field and Save come back, holding what was sent.
    mutating func refused() { sent = nil }
}
