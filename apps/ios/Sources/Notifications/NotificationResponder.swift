import Foundation
import UserNotifications

enum NotificationActionID {
    static let approve = "ACE_APPROVE"
    static let deny = "ACE_DENY"
    /// Allow and Deny need an unlocked device and answer without opening the app.
    static var categories: Set<UNNotificationCategory> {
        let allow = UNNotificationAction(identifier: approve, title: "Allow", options: [.authenticationRequired])
        let refuse = UNNotificationAction(identifier: deny, title: "Deny", options: [.authenticationRequired, .destructive])
        return [UNNotificationCategory(identifier: AlertContent.approvalCategory, actions: [allow, refuse], intentIdentifiers: []),
                UNNotificationCategory(identifier: AlertContent.threadCategory, actions: [], intentIdentifiers: [])]
    }
}

/// The connection a background launch uses: the spike fixture under `--spike`, otherwise the
/// paired machine a relaunch would reconnect to, with its grant, Keychain token and outbox.
enum BackgroundConnection {
    @MainActor static func connect(_ coordinator: NotificationCoordinator) async -> ClientModel? {
        guard let directory = try? ProductionApp.storageDirectory() else { return nil }
        let model = ClientModel(now: coordinator.now)
        if SpikeConfiguration.enabled {
            guard let target = SpikeConfiguration.target() else { return nil }
            await coordinator.attach(model, target: target)
            await model.connect(target: target, directory: directory)
            return model
        }
        let machines = ProductionApp.machines(client: model, directory: directory, notifications: coordinator)
        await machines.load()
        guard machines.active?.connectionTarget != nil else {
            coordinator.detach(model)
            await model.disconnectAndWait()
            return nil
        }
        return model
    }
}

extension NotificationCoordinator {
    /// Tap opens the thread. Allow/Deny answer the exact option the daemon offered, and only after
    /// reading the interaction's current state (ADR 0012); a notification grants no authority.
    func respond(action: String, notificationId: String, info: [String: String]) async {
        guard let threadId = info[NotificationKeys.threadId] else { return }
        let option = action == NotificationActionID.approve ? info[NotificationKeys.approve]
            : action == NotificationActionID.deny ? info[NotificationKeys.deny] : nil
        guard let option, let interactionId = info[NotificationKeys.interactionId] else {
            if let model { model.deepLink = threadId } else { pendingLink = threadId }
            return
        }
        let outcome = await resolve(threadId: threadId, interactionId: interactionId, optionId: option)
        let title = "Request not answered"
        switch outcome {
        case .confirmed?, .stale?: notifier.withdraw(notificationId) // Answered, here or elsewhere.
        case .refused?:
            await notifier.notice(id: "action:\(notificationId)", threadId: threadId, title: title,
                                  body: "Your machine didn't accept the answer. Open ace to see the request.")
        case .saved?:
            await notifier.notice(id: "action:\(notificationId)", threadId: threadId, title: "Answer saved",
                                  body: "It sends when your machine is reachable. Open ace to check.")
        default:
            await notifier.notice(id: "action:\(notificationId)", threadId: threadId, title: title,
                                  body: "Couldn't reach your machine. Open ace to answer.")
        }
        await releaseTransient()
    }
    func resolve(threadId: String, interactionId: String, optionId: String) async -> NotificationPatch.ActionOutcome? {
        guard let model = await session(.seconds(10)) else { return .unreachable }
        // A view-only pairing answers nothing; the person answers on the computer.
        guard model.canOperate else { return .refused }
        let requestId = makeId()
        let outcome = Waiter<NotificationPatch.ActionOutcome>()
        expect(requestId, outcome)
        guard model.notificationAction(["type": "notifications.resolve", "requestId": requestId, "threadId": threadId,
                                         "interactionId": interactionId, "optionId": optionId]) else { return .unreachable }
        return await outcome.wait(.seconds(15), sleep: sleep) ?? outcome.latest
    }
    /// BGAppRefreshTask: connect briefly, fetch what a suspended app missed, then let go.
    func backgroundCatchUp() async -> Bool {
        if permission == .unknown { await refreshPermission() }
        guard delivering else { return true }
        guard await session(.seconds(10)) != nil else { await releaseTransient(); return false }
        let caught = await Waiter.wait(.seconds(10), sleep: sleep, fallback: false) { waiter in
            expectFeed(waiter)
            sync()
        }
        await releaseTransient()
        return caught
    }
    /// The attached connection, or a short-lived one. Nil unless it is ready within the budget.
    func session(_ budget: Duration) async -> ClientModel? {
        var current = model
        if current == nil, let made = await connectInBackground(self) { transient = made; current = made }
        guard let current else { return nil }
        if current.connection != "ready" { current.retry() }
        var waited = Duration.zero
        while current.connection != "ready", waited < budget {
            await sleep(.milliseconds(100))
            waited += .milliseconds(100)
        }
        return current.connection == "ready" ? current : nil
    }
    func releaseTransient() async {
        guard let transient else { return }
        self.transient = nil
        detach(transient)
        await transient.disconnectAndWait()
    }
    /// While the user looks at a thread, its own alerts stay out of the way.
    func presentation(for threadId: String?) -> UNNotificationPresentationOptions {
        if foreground, let threadId, model?.thread?.id == threadId { return [] }
        return [.banner, .list, .sound]
    }
}
