import Foundation

/// What a local notification shows for one canonical alert. Pure, so wording rules are testable.
struct AlertContent: Equatable, Sendable {
    static let approvalCategory = "ACE_APPROVAL"
    static let threadCategory = "ACE_THREAD"
    enum Level: Equatable, Sendable { case passive, active, timeSensitive }

    let identifier: String
    let title: String
    let body: String
    let threadIdentifier: String
    let category: String
    private(set) var level: Level
    let threadId: String
    let interactionId: String?
    /// Option ids for the approve/deny buttons, exactly as the daemon offered them.
    let approveOption: String?
    let denyOption: String?
    /// The paired machine that raised it; nil only for the debug fixture or tests.
    var hostId: String? = nil
    /// Shown over the open app; false files it in the list only (Settings › Notifications).
    var banner = true

    /// The system request identifier for a daemon alert. Alert ids are unique only within their
    /// daemon, so the machine is part of it: the same id from two machines is two notifications.
    static func requestId(_ alertId: String, hostId: String?) -> String {
        hostId.map { "\($0)|\(alertId)" } ?? alertId
    }
    /// What to withdraw for a retracted alert: its id, plus the bare id builds before
    /// namespacing posted, so an alert shown before an update is still withdrawn.
    static func requestIds(retracting alertId: String, hostId: String?) -> [String] {
        let id = requestId(alertId, hostId: hostId)
        return id == alertId ? [id] : [id, alertId]
    }
    /// A local notice, not a daemon alert: no buttons, opens the thread.
    static func notice(id: String, threadId: String, title: String, body: String, hostId: String? = nil) -> AlertContent {
        var content = AlertContent(identifier: id, title: title, body: body, threadId: threadId)
        content.hostId = hostId
        return content
    }
    private init(identifier: String, title: String, body: String, threadId: String) {
        self.identifier = identifier; self.title = title; self.body = body
        threadIdentifier = threadId; self.threadId = threadId; category = Self.threadCategory; level = .active
        interactionId = nil; approveOption = nil; denyOption = nil
    }
    init(_ alert: AlertNotification, hostId: String? = nil) {
        self.hostId = hostId
        identifier = Self.requestId(alert.id, hostId: hostId)
        title = alert.title.isEmpty ? "ace" : alert.title
        threadIdentifier = alert.threadId
        threadId = alert.threadId
        interactionId = alert.interactionId
        approveOption = alert.actions.first { $0.action == "approve" }?.optionId
        denyOption = alert.actions.first { $0.action == "deny" }?.optionId
        // Buttons only for the daemon's fixed approve/deny case; anything else opens the app.
        category = alert.interactionId != nil && approveOption != nil && denyOption != nil ? Self.approvalCategory : Self.threadCategory
        let phrase: String
        switch alert.status {
        case "needs_you": phrase = "Needs you"; level = .timeSensitive
        case "done": phrase = "Done"; level = .active
        case "failed": phrase = "Failed"; level = .active
        case "unresponsive": phrase = "Not responding"; level = .active
        case "background_done":
            phrase = alert.backgroundCount == 1 ? "1 background task done" : "\(alert.backgroundCount) background tasks done"
            level = .passive
        case "agent_says": phrase = "Agent says"; level = .active
        default: phrase = "New activity"; level = .active // Unknown statuses never claim done.
        }
        let detail = alert.status == "agent_says" ? alert.message : alert.preview
        body = detail.map { "\(phrase): \($0)" } ?? phrase
        // Quiet hours, or a category whose banner is off: straight to the list, no sound.
        if alert.delivery?.interrupt == false { level = .passive }
        banner = alert.delivery?.banner ?? true
    }
}
