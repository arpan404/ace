import Foundation

/// Settings › Spade as the bridge reads it (`bridge/spade-settings.ts`): one page at a time, each
/// change answered with the page as it now is. Every word is the bridge's. No row ever holds a
/// key's value: Spade only says whether one is set and where it comes from (ADR 0119).
enum SpadeSettings {
    enum Page: String, CaseIterable, Identifiable, Sendable {
        case general, models, search, apps
        var id: String { rawValue }
        var title: String {
            switch self {
            case .general: "General"
            case .models: "Models and keys"
            case .search: "Web search"
            case .apps: "Apps"
            }
        }
        var symbol: String {
            switch self {
            case .general: "gearshape"
            case .models: "key"
            case .search: "globe"
            case .apps: "puzzlepiece.extension"
            }
        }
    }

    struct Choice: Decodable, Equatable, Sendable, Hashable {
        let value: String
        let name: String
    }
    /// The models one endpoint or subscription offers.
    struct Group: Decodable, Equatable, Sendable, Hashable {
        let label: String
        let choices: [Choice]
    }
    /// One model setting: "" is its empty choice, whose words are `none`.
    struct ModelSetting: Decodable, Equatable, Sendable, Identifiable {
        let role: String
        let title: String
        let line: String?
        let value: String
        let words: String
        let none: String
        var id: String { role }
    }
    struct Run: Decodable, Equatable, Sendable {
        let on: Bool?
        let line: String?
    }
    struct General: Decodable, Equatable, Sendable {
        let run: Run
        let models: [ModelSetting]
        let groups: [Group]
        /// Models left out so the page fits one frame.
        let more: Int
    }
    struct Key: Decodable, Equatable, Sendable {
        let words: String
        let set: Bool
        let canSet: Bool
        let canRemove: Bool
    }
    struct Endpoint: Decodable, Equatable, Sendable, Identifiable {
        let id: String
        let name: String
        let address: String
        let key: Key
        let models: [String]
        let more: Int
    }
    struct Preset: Decodable, Equatable, Sendable, Identifiable {
        let id: String
        let name: String
    }
    struct Models: Decodable, Equatable, Sendable {
        let endpoints: [Endpoint]
        let presets: [Preset]
        let keychain: Bool
        let note: String
    }
    struct Brave: Decodable, Equatable, Sendable {
        let set: Bool
        let words: String
        let canSet: Bool
    }
    struct Search: Decodable, Equatable, Sendable {
        let searxng: String?
        let brave: Brave
        let keychain: Bool
    }
    struct App: Decodable, Equatable, Sendable, Identifiable {
        let id: String
        let name: String
        let health: String
        let ok: Bool
        let account: String?
        let line: String
    }
    struct Skill: Decodable, Equatable, Sendable, Hashable {
        let name: String
        let line: String
    }
    struct Apps: Decodable, Equatable, Sendable {
        let apps: [App]
        let skills: [Skill]
    }

    /// One page's read or change: the page, or Spade's state when it can't answer, or a refusal.
    struct Answer: Decodable, Equatable, Sendable {
        let ok: Bool
        let title: String?
        let message: String?
        let line: SpadeModel.Line?
        let general: General?
        let models: Models?
        let search: Search?
        let apps: Apps?

        static func failed(_ title: String, _ message: String?) -> Answer {
            Answer(ok: false, title: title, message: message, line: nil, general: nil, models: nil, search: nil, apps: nil)
        }
        /// Why it failed, in one line; nil when it went.
        var problem: String? {
            guard !ok else { return nil }
            let said = [title, message].compactMap(\.self).filter { !$0.isEmpty }
            return said.isEmpty ? "Try again." : said.joined(separator: ". ")
        }
    }
}

/// What New bot offers (`bridge/spade-new-bot.ts`), or the bot it made.
struct SpadeNewBotAnswer: Decodable, Equatable, Sendable {
    struct Template: Decodable, Equatable, Sendable, Identifiable {
        let id: String
        let name: String
        let blurb: String
        let face: SpadeModel.Face
    }
    let ok: Bool
    let title: String?
    let message: String?
    let templates: [Template]?
    let model: SpadeSettings.ModelSetting?
    let groups: [SpadeSettings.Group]?
    let agentId: String?
    let conversation: String?

    static func failed(_ title: String, _ message: String?) -> SpadeNewBotAnswer {
        SpadeNewBotAnswer(ok: false, title: title, message: message, templates: nil, model: nil, groups: nil,
                          agentId: nil, conversation: nil)
    }
    var problem: String? {
        guard !ok else { return nil }
        let said = [title, message].compactMap(\.self).filter { !$0.isEmpty }
        return said.isEmpty ? "Try again." : said.joined(separator: ". ")
    }
}

/// A page's reads and writes as they land: only the latest one shows, a failed read keeps the
/// page already shown, and a refused change says why while the page stays as it was.
struct SpadeSettingsReads: Equatable {
    private(set) var answer: SpadeSettings.Answer?
    /// Why the page couldn't be read, while there is none to show.
    private(set) var problem: String?
    /// Why the last change was refused, under the page.
    private(set) var refusal: String?
    private var generation = 0

    mutating func begin() -> Int {
        generation += 1
        return generation
    }
    /// A read came back.
    mutating func land(_ fresh: SpadeSettings.Answer, ticket: Int) {
        guard ticket == generation else { return }
        if fresh.ok {
            answer = fresh
            problem = nil
        } else if answer == nil {
            problem = fresh.problem
        }
    }
    /// A change came back: the page as it now is, or why it was refused.
    /// A refusal always says why; a page newer than this one is kept.
    mutating func changed(_ fresh: SpadeSettings.Answer, ticket: Int) {
        guard fresh.ok else {
            refusal = fresh.problem
            return
        }
        refusal = nil
        guard ticket == generation else { return }
        answer = fresh
        problem = nil
    }
    mutating func clearRefusal() { refusal = nil }
}
