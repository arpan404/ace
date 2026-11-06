import Foundation

/// What a local notification shows for one canonical alert. Pure, so wording rules are testable.
struct AlertContent: Equatable, Sendable {
    static let approvalCategory = "ACE_APPROVAL"
    static let threadCategory = "ACE_THREAD"
    /// A finished, failed or talking thread: Reply sends the next message.
    static let replyCategory = "ACE_REPLY"
    /// A question the person answers in their own words.
    static let answerCategory = "ACE_ANSWER"
    enum Level: Equatable, Sendable { case passive, active, timeSensitive }

    /// The system request identifier; `AlertStack` sets the thread's own when it lands.
    var identifier: String
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
    /// The question a choice or Reply answers, and the options shown as buttons.
    private(set) var questionId: String? = nil
    private(set) var choices: [AlertNotification.Request.Choice] = []
    /// The question also takes the person's own words (Reply beside the choices).
    private(set) var takesWords = false
    /// The paired machine that raised it; nil only for the debug fixture or tests.
    var hostId: String? = nil
    /// Shown over the open app; false files it in the list only (Settings › Notifications).
    var banner = true
    /// The thread's own title, for the finished summary.
    private(set) var threadTitle = ""

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
    /// A local notice, not a daemon alert: an action's outcome. Quiet, no buttons, opens the thread.
    static func notice(id: String, threadId: String, title: String, body: String, hostId: String? = nil) -> AlertContent {
        var content = AlertContent(identifier: id, title: title, body: body, threadId: threadId)
        content.hostId = hostId
        return content
    }
    /// Several threads that finished close together, as one quiet notification: "3 threads
    /// finished" over their titles, newest first. It opens ace, not one of them.
    static func finishedSummary(count: Int, titles: [String]) -> AlertContent {
        let named = titles.prefix(3).joined(separator: ", ")
        let body = titles.count > 3 ? "\(named) and \(titles.count - 3) more" : named
        return AlertContent(identifier: AlertStack.summaryId, title: "\(count) threads finished", body: body, threadId: "",
                            group: AlertStack.summaryId)
    }
    private init(identifier: String, title: String, body: String, threadId: String, group: String? = nil) {
        self.identifier = identifier; self.title = title; self.body = body
        threadIdentifier = group ?? threadId; self.threadId = threadId; category = Self.threadCategory; level = .passive
        interactionId = nil; approveOption = nil; denyOption = nil
    }
    init(_ alert: AlertNotification, hostId: String? = nil) {
        self.hostId = hostId
        identifier = Self.requestId(alert.id, hostId: hostId)
        threadIdentifier = alert.threadId
        threadId = alert.threadId
        interactionId = alert.interactionId
        approveOption = alert.actions.first { $0.action == "approve" }?.optionId
        denyOption = alert.actions.first { $0.action == "deny" }?.optionId
        let thread = alert.title.isEmpty ? "ace" : alert.title
        threadTitle = alert.title.isEmpty ? "New thread" : alert.title
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
        // A request read from the thread says who asks and what for; the thread and its one line
        // go underneath ("Claude Code wants to run a command" / "Fleet map · bun run test").
        if alert.status == "needs_you", let request = alert.request, !request.sentence.isEmpty {
            title = request.sentence
            body = request.detail.isEmpty ? thread : "\(thread) · \(request.detail)"
        } else {
            title = thread
            let detail = alert.status == "agent_says" ? alert.message : alert.preview
            body = detail.map { "\(phrase): \($0)" } ?? phrase
        }
        category = Self.category(alert)
        if category != Self.approvalCategory, category != Self.threadCategory, category != Self.replyCategory {
            questionId = alert.request?.questionId
            choices = category == Self.answerCategory ? [] : alert.request?.choices ?? []
            takesWords = alert.request?.reply ?? false
        }
        // Quiet hours, or a category whose banner is off: straight to the list, no sound.
        if alert.delivery?.interrupt == false { level = .passive }
        banner = alert.delivery?.banner ?? true
    }

    /// Which buttons the alert gets. Allow/Deny only for the daemon's fixed approve/deny pair; a
    /// single short question its options (and Reply when it takes words); a finished, failed or
    /// talking thread Reply. Anything else opens the app.
    private static func category(_ alert: AlertNotification) -> String {
        let approve = alert.actions.contains { $0.action == "approve" }, deny = alert.actions.contains { $0.action == "deny" }
        if alert.interactionId != nil, approve, deny { return approvalCategory }
        if alert.status == "needs_you", alert.interactionId != nil, let request = alert.request,
           request.kind == "question", request.questionId != nil {
            if !request.choices.isEmpty { return NotificationCategories.choiceId(request.choices.map(\.label), reply: request.reply) }
            if request.reply { return answerCategory }
            return threadCategory
        }
        if ["done", "failed", "agent_says"].contains(alert.status) { return replyCategory }
        return threadCategory
    }
}
