import Foundation

/// Settings › Spade as the bridge reads it (`bridge/spade-settings.ts`): one page at a time, each
/// change answered with the page as it now is. Every word is the bridge's. No row ever holds a
/// key's value: Spade only says whether one is set and where it comes from (ADR 0119).
enum SpadeSettings {
    enum Page: String, CaseIterable, Identifiable, Sendable {
        case general, models, apps, security
        var id: String { rawValue }
        var title: String {
            switch self {
            case .general: "General"
            case .models: "Models and keys"
            case .apps: "Apps"
            case .security: "Security"
            }
        }
        /// Its glyph, from ace's own icon set.
        var icon: AceIcon.Name {
            switch self {
            case .general: .gear
            case .models: .key
            case .apps: .puzzlePiece
            case .security: .shield
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
        /// This month's ace searches, or the sign-in sentence; nil when Spade can't say.
        var search: String? = nil
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
    /// A device sign-in waiting on the person: the code, and the page to enter it on.
    struct Device: Decodable, Equatable, Sendable {
        let code: String
        let url: String
    }
    struct App: Decodable, Equatable, Sendable, Identifiable {
        let id: String
        let name: String
        let health: String
        let ok: Bool
        let account: String?
        let line: String
        /// Its sign-in ended: `token` (pasted here) or `sign_in`; nil while it works.
        let reconnect: String?
        let device: Device?
    }
    struct Skill: Decodable, Equatable, Sendable, Hashable {
        let name: String
        let line: String
    }
    struct Apps: Decodable, Equatable, Sendable {
        let apps: [App]
        let skills: [Skill]
    }

    /// One of the Permissions (ADR 0171, amendment 7), as a bot or the machine's default holds it.
    struct Permission: Decodable, Equatable, Sendable, Identifiable {
        let key: String
        let title: String
        let line: String
        let on: Bool
        /// A bot sets it itself, so it offers Use default; never on the machine's defaults.
        let own: Bool
        var id: String { key }
    }
    struct AutonomyChoice: Decodable, Equatable, Sendable, Hashable {
        let value: String
        let label: String
    }
    /// Turning Full access on asks first, in these words.
    struct Confirm: Decodable, Equatable, Sendable {
        let title: String
        let message: String
        let button: String
    }
    /// How bots decide: Auto-review, or Full access with what still asks.
    struct Autonomy: Decodable, Equatable, Sendable {
        let value: String
        let choices: [AutonomyChoice]
        let fullAccess: String?
        let confirm: Confirm
    }
    struct Security: Decodable, Equatable, Sendable {
        /// Whether this machine seals commands off, said first.
        let line: String
        /// Nil from a Spade before Permissions.
        let permissions: [Permission]?
        let neverApps: [String]?
        let autonomy: Autonomy
    }

    /// One page's read or change: the page, or Spade's state when it can't answer, or a refusal.
    struct Answer: Decodable, Equatable, Sendable {
        let ok: Bool
        let title: String?
        let message: String?
        let line: SpadeModel.Line?
        /// Beside the page: a write that went through when the page couldn't be read again, or
        /// where to finish an app's sign-in.
        var notice: String? = nil
        let general: General?
        let models: Models?
        let apps: Apps?
        var security: Security? = nil

        static func failed(_ title: String, _ message: String?) -> Answer {
            Answer(ok: false, title: title, message: message, line: nil, general: nil, models: nil, apps: nil)
        }
        /// It carries a page to show, not only Spade's state or a word.
        var hasPage: Bool { general != nil || models != nil || apps != nil || security != nil }
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
        /// Its routines and their schedules in one line; nil when it has none.
        let routines: String?
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
    /// Why the last change was refused, at the page's top.
    private(set) var refusal: String?
    /// What the last change said beside the page: saved without a fresh page, or where to finish.
    private(set) var notice: String?
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
        notice = fresh.notice
        // Saved, but the page couldn't be read again: the page shown stays, with the word.
        guard ticket == generation, fresh.hasPage else { return }
        answer = fresh
        problem = nil
    }
    mutating func clearRefusal() {
        refusal = nil
        notice = nil
    }
}
