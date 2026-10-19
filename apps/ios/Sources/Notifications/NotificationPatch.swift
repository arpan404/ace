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

/// Bridge patches whose `type` starts with `notifications.`.
enum NotificationPatch: Decodable, Sendable, Equatable {
    case alert(AlertNotification)
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
