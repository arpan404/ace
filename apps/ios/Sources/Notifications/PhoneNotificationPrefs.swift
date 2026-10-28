import Foundation

/// This phone's own notification preferences (Settings › Notifications): which categories show a
/// banner while ace is open and a system notification while it's away, and quiet hours. Kept on
/// the phone and sent to every machine's runtime, where bridge/notification-delivery.ts decides
/// each alert; Swift only stores and shows them.
struct PhoneNotificationPrefs: Codable, Equatable, Sendable {
    struct Categories: Codable, Equatable, Sendable {
        var needsYou = true
        var failures = true
        var finished = true
        var agentSays = true
        subscript(_ key: String) -> Bool {
            get { switch key { case "needsYou": needsYou; case "failures": failures; case "finished": finished; default: agentSays } }
            set {
                switch key {
                case "needsYou": needsYou = newValue
                case "failures": failures = newValue
                case "finished": finished = newValue
                default: agentSays = newValue
                }
            }
        }
    }
    /// Minutes after local midnight; the window may cross midnight.
    struct Window: Codable, Equatable, Sendable { var start: Int; var end: Int }

    var inApp = Categories()
    var system = Categories()
    var quietHours: Window? = nil

    /// The four categories in the order Settings lists them, with the desktop's names.
    static let categories: [(key: String, title: String)] = [
        ("needsYou", "Needs you"), ("failures", "Failures"), ("finished", "Thread done"), ("agentSays", "Agent messages"),
    ]
    static let defaultQuietHours = Window(start: 22 * 60, end: 7 * 60)
    static let storageKey = "ace.notifications.phone"

    static func load(_ defaults: UserDefaults) -> PhoneNotificationPrefs {
        guard let data = defaults.data(forKey: storageKey), data.count <= 4096,
              let value = try? JSONDecoder().decode(PhoneNotificationPrefs.self, from: data) else { return PhoneNotificationPrefs() }
        return value
    }
    func save(_ defaults: UserDefaults) {
        if let data = try? JSONEncoder().encode(self) { defaults.set(data, forKey: Self.storageKey) }
    }
    /// The runtime's wire form (`notifications.sync` `phone`).
    var json: Any? {
        guard let data = try? JSONEncoder().encode(self) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }
}
