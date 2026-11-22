import Foundation

/// One version of a bot's task (`bridge/spade-library.ts`), newest first.
struct SpadeTaskVersion: Decodable, Equatable, Hashable, Identifiable, Sendable {
    let seq: Int
    /// When it was made, in ms; nil for one from before history was kept.
    let at: Double?
    /// Who made it, in words: "Changed by you".
    let by: String
    let why: String
    let task: String
    var id: Int { seq }
    /// Its first line, for the folded list.
    var firstLine: String {
        task.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n").first.map(String.init) ?? ""
    }
}

/// A row of a Library list: a note, a page, a piece of past work, a file or a skill.
struct SpadeLibraryRow: Decodable, Equatable, Hashable, Identifiable, Sendable {
    let id: String
    let title: String
    let line: String?
    /// When it last changed or closed, in ms.
    let at: Double?
    /// `note`, `page`, `episode`, `file`, `folder` or `skill`.
    let kind: String
    var icon: AceIcon.Name {
        switch kind {
        case "page": .fileText
        case "episode": .checkCircle
        case "folder": .folder
        case "file": .file
        case "skill": .stack
        default: .note
        }
    }
}

struct SpadeLibraryGroup: Decodable, Equatable, Identifiable, Sendable {
    let name: String
    let rows: [SpadeLibraryRow]
    let more: Int
    var id: String { name }
}

/// What a request of the Library area answers: its value, or why it couldn't be read.
struct SpadeLibraryAnswer: Decodable, Sendable {
    let ok: Bool
    let title: String?
    let message: String?
    // `spade.task.history`
    let versions: [SpadeTaskVersion]?
    // `spade.library.search`
    let groups: [SpadeLibraryGroup]?
    let failed: Bool?
    /// "Nothing matches “zebra”." once, when nothing anywhere does.
    let nothing: String?
    // `spade.library.past`
    let episodes: [SpadeLibraryRow]?
    let more: Int?
    // `spade.library.episode`
    let episode: SpadeEpisodePage?
    var problem: String? { SpadeOutcome(ok: ok, title: title, message: message).problem }

    static func refused(_ title: String, _ message: String?) -> SpadeLibraryAnswer {
        SpadeLibraryAnswer(ok: false, title: title, message: message, versions: nil, groups: nil, failed: nil,
                           nothing: nil, episodes: nil, more: nil, episode: nil)
    }
}

/// A piece of past work, open to read, its words written by the bridge.
struct SpadeEpisodePage: Decodable, Equatable, Sendable {
    struct Criterion: Decodable, Equatable, Hashable, Sendable {
        let text: String
        let met: Bool?
    }
    let id: String
    let title: String
    let startedAt: Double
    let closedAt: Double
    /// "Done and checked", "Ended", "Ended as failed".
    let outcome: String
    let cost: String?
    let untrusted: Bool
    let text: String
    let criteria: [Criterion]
    let worked: [String]
    let failed: [String]
    let missing: [String]
    /// The bot's own last word on it.
    let note: String?
}

// Episode rows come back without a kind: they are all past work.
extension SpadeLibraryRow {
    private enum Keys: String, CodingKey { case id, title, line, at, kind }
    init(from decoder: any Decoder) throws {
        let box = try decoder.container(keyedBy: Keys.self)
        id = try box.decode(String.self, forKey: .id)
        title = try box.decode(String.self, forKey: .title)
        line = try box.decodeIfPresent(String.self, forKey: .line)
        at = try box.decodeIfPresent(Double.self, forKey: .at)
        kind = try box.decodeIfPresent(String.self, forKey: .kind) ?? "episode"
    }
}

/// A bot's task history, Library search and past work (`bridge/spade-library.ts`).
extension ClientModel {
    private func spadeLibrary(_ payload: [String: Any], failing title: String) async -> SpadeLibraryAnswer {
        do { return try await service(payload, as: SpadeLibraryAnswer.self) }
        catch is CancellationError { return .refused(title, nil) }
        catch { return .refused(title, error.localizedDescription) }
    }

    func spadeTaskHistory(_ agent: String) async -> SpadeLibraryAnswer {
        await spadeLibrary(["type": "spade.task.history", "agentId": agent], failing: "Couldn't read the task's history")
    }

    func spadeLibrarySearch(_ agent: String, query: String) async -> SpadeLibraryAnswer {
        await spadeLibrary(["type": "spade.library.search", "agentId": agent, "query": query], failing: "Couldn't search")
    }

    func spadeLibraryPast(_ agent: String) async -> SpadeLibraryAnswer {
        await spadeLibrary(["type": "spade.library.past", "agentId": agent], failing: "Couldn't read the past work")
    }

    func spadeLibraryEpisode(_ id: String) async -> SpadeLibraryAnswer {
        await spadeLibrary(["type": "spade.library.episode", "id": id], failing: "Couldn't read it")
    }
}
