import Foundation

/// The coordinator's side of the lock screen: what the hub reads from every attached machine,
/// the approvals the Live Activity can answer, and its on/off switch.
extension NotificationCoordinator {
    /// Every attached machine's rows, and the approvals whose rows still need the person. An
    /// approval whose row moved on is dropped here, so a stale one never gets buttons.
    func lockScreenInput() -> LockScreenHub.Input {
        var waiting: Set<String> = []
        let list = machines.map { entry in
            let rows = Array(entry.model.inbox.values)
            for row in rows where row.look?.level == "needs-you" { waiting.insert(LockScreenBuilder.key(host: entry.hostId, thread: row.id)) }
            return LockScreenBuilder.Machine(hostId: entry.hostId, rows: rows, online: entry.model.connection == "ready")
        }
        approvals = approvals.filter { waiting.contains($0.key) }
        return (list, approvals)
    }

    /// An alert for an approval with the daemon's fixed Allow/Deny pair: the Live Activity may
    /// offer the same two answers while the thread still needs the person.
    func note(_ alert: AlertNotification, from hostId: String) {
        guard alert.status == "needs_you", let interaction = alert.interactionId,
              let approve = alert.actions.first(where: { $0.action == "approve" })?.optionId,
              let deny = alert.actions.first(where: { $0.action == "deny" })?.optionId else { return }
        let key = LockScreenBuilder.key(host: hostId, thread: alert.threadId)
        let request = alert.request
        approvals[key] = LockRequest(hostId: hostId, threadId: alert.threadId, interactionId: interaction, approve: approve, deny: deny,
                                     sentence: request?.sentence ?? "An agent wants your approval", detail: request?.detail ?? "",
                                     code: request?.code ?? false, title: alert.title)
        approvalAlerts[AlertContent.requestId(alert.id, hostId: hostId)] = key
        lockScreen.changed()
    }
    func forget(_ retracted: [String], from hostId: String) {
        for id in retracted {
            guard let key = approvalAlerts.removeValue(forKey: AlertContent.requestId(id, hostId: hostId)) else { continue }
            approvals.removeValue(forKey: key)
        }
        if !retracted.isEmpty { lockScreen.changed() }
    }

    /// Allow or Deny from the Live Activity: the same path as the notification's buttons, so it
    /// reads the request's current state first and reports anything but a confirmed answer.
    func answer(_ request: LockRequest, allow: Bool) async {
        let answer = NotificationAnswer.option(interactionId: request.interactionId, optionId: allow ? request.approve : request.deny)
        let alert = approvalAlerts.first { $0.value == LockScreenBuilder.key(host: request.hostId, thread: request.threadId) }?.key
        let outcome = await perform(answer, threadId: request.threadId, hostId: request.hostId)
        if outcome == .confirmed || outcome == .stale { approvals.removeValue(forKey: LockScreenBuilder.key(host: request.hostId, thread: request.threadId)) }
        await report(outcome, for: answer, notificationId: alert ?? "activity|\(request.interactionId)", threadId: request.threadId, hostId: request.hostId)
        lockScreen.rebuild()
        await releaseTransient()
    }

}
