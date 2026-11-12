import Foundation

/// The daemon's canonical `Notification` (protocol/notifications.ts). Swift never derives one from status.
struct AlertNotification: Codable, Sendable, Equatable, Identifiable {
    struct Action: Codable, Sendable, Equatable { let action: String; let optionId: String }
    let id: String
    let threadId: String
    let title: String
    let status: String
    let interactionId: String?
    let backgroundCount: Int
    let actions: [Action]
    let preview: String?
    let message: String?
    /// How this phone shows it, by its own preferences (bridge/notification-delivery.ts). Nil from
    /// older runtimes: posted and shown as before.
    var delivery: Delivery? = nil
    struct Delivery: Codable, Sendable, Equatable { let post: Bool; let interrupt: Bool; let banner: Bool }
    /// What a needs-you alert asks, read from the pending request (bridge/notification-request.ts).
    /// Nil when it couldn't be read in time, and from older runtimes: the alert posts plainly.
    var request: Request? = nil
    struct Request: Codable, Sendable, Equatable {
        struct Choice: Codable, Sendable, Equatable { let id: String; let label: String }
        /// "approval", "question" or "other".
        let kind: String
        /// "Claude Code wants to run a command".
        let sentence: String
        let detail: String
        let code: Bool
        let questionId: String?
        /// A short question's options, offered as buttons.
        let choices: [Choice]
        /// The person's own words answer it.
        let reply: Bool
    }
}

struct QuietHours: Codable, Sendable, Equatable {
    var timeZone: String
    var startMinute: Int
    var endMinute: Int
}
/// `notification.preferences`, as the daemon stores it for this device.
struct NotificationPreferences: Codable, Sendable, Equatable {
    var quietHours: QuietHours?
    var includePreview: Bool
    var agentSays: Bool?
    static let standard = NotificationPreferences(quietHours: nil, includePreview: false, agentSays: nil)
}

/// A usage-limit change the bridge judged (`bridge/limit-alerts.ts`), with how this phone shows it.
struct LimitNotification: Codable, Sendable, Equatable {
    let key: String
    let title: String
    let body: String
    var delivery: AlertNotification.Delivery? = nil
}

/// A finished or failed automation run the bridge picked (`bridge/run-alerts.ts`), with how this
/// phone shows it. Its body says how the run went, never what it printed.
struct RunNotification: Codable, Sendable, Equatable {
    let key: String
    let title: String
    let body: String
    /// The thread the run started, which a tap opens; nil opens ace.
    var threadId: String? = nil
    let automationId: String
    var delivery: AlertNotification.Delivery? = nil
}

/// Bridge patches whose `type` starts with `notifications.`.
enum NotificationPatch: Decodable, Sendable, Equatable {
    case alert(AlertNotification)
    case limit(LimitNotification)
    case run(RunNotification)
    case feed(cursor: Int, entries: [AlertNotification], retracted: [String])
    case config(NotificationPreferences)
    case action(id: String, outcome: ActionOutcome)
    /// A connection opened; the coordinator answers with its current state (`notifications.sync`).
    case connected

    enum ActionOutcome: String, Codable, Sendable { case stale, unreachable, unsaved, saved, confirmed, refused }
    private enum Keys: String, CodingKey { case type, notification, cursor, entries, retracted, preferences, id, outcome }
    init(from decoder: any Decoder) throws {
        let box = try decoder.container(keyedBy: Keys.self)
        switch try box.decode(String.self, forKey: .type) {
        case "notifications.alert": self = .alert(try box.decode(AlertNotification.self, forKey: .notification))
        case "notifications.limit": self = .limit(try LimitNotification(from: decoder))
        case "notifications.run": self = .run(try RunNotification(from: decoder))
        case "notifications.feed":
            self = .feed(cursor: try box.decode(Int.self, forKey: .cursor),
                         entries: try box.decode([AlertNotification].self, forKey: .entries),
                         retracted: try box.decode([String].self, forKey: .retracted))
        case "notifications.connected": self = .connected
        case "notifications.config": self = .config(try box.decode(NotificationPreferences.self, forKey: .preferences))
        case "notifications.action":
            self = .action(id: try box.decode(String.self, forKey: .id), outcome: try box.decode(ActionOutcome.self, forKey: .outcome))
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: box, debugDescription: "Unknown notification patch")
        }
    }
}
