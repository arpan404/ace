import Foundation

/// What the person edits on a bot's profile beyond its task, as the bridge shapes it
/// (`bridge/spade-profile-details.ts`): personality, notifications and spending; the models for
/// its other work; its network rules; its checkpoints.
enum SpadeProfileEdits {
    struct Tone: Decodable, Equatable, Sendable, Hashable {
        let value: String
        let label: String
        let says: String
    }
    struct Personality: Decodable, Equatable, Sendable {
        /// Nil leaves the manner to the bot.
        var tone: String?
        var humour: Bool
        var emoji: Bool
        let tones: [Tone]
    }
    struct Spending: Decodable, Equatable, Sendable {
        let month: String
        let today: String
    }
    struct Reach: Decodable, Equatable, Sendable {
        let notify: Bool
        /// `inherit`, `notify` or `wait`.
        let approvals: String
    }
    /// Personality, spending and notifications, read at once.
    struct Details: Decodable, Equatable, Sendable {
        var personality: Personality
        let spending: Spending?
        /// Nil when Spade couldn't say: the section isn't shown.
        var reach: Reach?
    }

    struct Role: Decodable, Equatable, Sendable, Identifiable {
        let role: String
        let title: String
        let spent: String
        let follows: Bool
        let value: String
        let words: String
        var id: String { role }
        /// As the model picker takes a setting: Follow Settings is its empty choice.
        var setting: SpadeSettings.ModelSetting {
            SpadeSettings.ModelSetting(role: role, title: title, line: nil, value: value, words: words, none: "Follow Settings")
        }
    }
    struct Roles: Decodable, Equatable, Sendable {
        let roles: [Role]
        let groups: [SpadeSettings.Group]
        let more: Int
    }

    struct Mode: Decodable, Equatable, Sendable, Hashable {
        let value: String
        let label: String
    }
    struct Site: Decodable, Equatable, Sendable, Hashable {
        let entry: String
        let line: String?
        /// `Remove` or `Put back`.
        let action: String
    }
    struct Policy: Decodable, Equatable, Sendable, Identifiable {
        /// `commands` or `plugins`.
        let which: String
        let title: String
        let mode: String
        let own: Bool
        let sites: [Site]
        let hosts: [String]
        var id: String { which }
    }
    struct Network: Decodable, Equatable, Sendable {
        /// "this Mac", or "this computer".
        let place: String
        let modes: [Mode]
        let policies: [Policy]
    }
    /// One change to a rule, as `spade.network.set` takes it.
    enum NetworkChange: Equatable, Sendable {
        case mode(String), add(String), removeEntry(String), removeDefault(String), restoreDefault(String), inherit
        var payload: [String: Any] {
            switch self {
            case .mode(let mode): ["mode": mode]
            case .add(let entry): ["add": entry]
            case .removeEntry(let entry): ["removeEntry": entry]
            case .removeDefault(let entry): ["removeDefault": entry]
            case .restoreDefault(let entry): ["restoreDefault": entry]
            case .inherit: ["inherit": true]
            }
        }
    }

    struct Checkpoint: Decodable, Equatable, Sendable, Identifiable {
        let id: String
        /// When it was taken, in ms.
        let at: Double
        let reason: String
    }
}
