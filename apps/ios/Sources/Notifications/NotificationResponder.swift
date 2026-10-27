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

/// The connections a background launch uses: the spike fixtures under `--spike`, otherwise every
/// paired machine, each with its own grant, Keychain token and outbox.
enum BackgroundConnection {
    @MainActor static func connect(_ coordinator: NotificationCoordinator) async -> [ClientModel] {
        guard let directory = try? ProductionApp.storageDirectory() else { return [] }
        if SpikeConfiguration.enabled {
            var models: [ClientModel] = []
            for spike in SpikeConfiguration.targets() {
                let model = ClientModel(now: coordinator.now)
                await coordinator.attach(model, target: spike.target)
                await model.connect(target: spike.target, directory: directory)
                models.append(model)
            }
            return models
        }
        let machines = ProductionApp.machines(directory: directory, notifications: coordinator, now: coordinator.now)
        await machines.load()
        return machines.inbox.sessions.map(\.client)
    }
}

extension NotificationCoordinator {
    /// Tap opens the thread on its machine. Allow/Deny answer the exact option the daemon offered,
    /// on the machine that raised it, and only after reading the interaction's current state
    /// (ADR 0012); a notification grants no authority.
    func respond(action: String, notificationId: String, info: [String: String]) async {
        guard let threadId = info[NotificationKeys.threadId] else { return }
        let hostId = info[NotificationKeys.hostId]
        let option = action == NotificationActionID.approve ? info[NotificationKeys.approve]
            : action == NotificationActionID.deny ? info[NotificationKeys.deny] : nil
        guard let option, let interactionId = info[NotificationKeys.interactionId] else {
            if let model = client(hostId) { model.deepLink = threadId } else { pendingLink = (threadId, hostId) }
            return
        }
        let outcome = await resolve(threadId: threadId, interactionId: interactionId, optionId: option, hostId: hostId)
        let title = "Request not answered"
        switch outcome {
        case .confirmed?, .stale?: notifier.withdraw(notificationId) // Answered, here or elsewhere.
        case .refused?:
            await notifier.notice(id: "action:\(notificationId)", threadId: threadId, title: title,
                                  body: "Your machine didn't accept the answer. Open ace to see the request.", hostId: hostId)
        case .saved?:
            await notifier.notice(id: "action:\(notificationId)", threadId: threadId, title: "Answer saved",
                                  body: "It sends when your machine is reachable. Open ace to check.", hostId: hostId)
        default:
            await notifier.notice(id: "action:\(notificationId)", threadId: threadId, title: title,
                                  body: "Couldn't reach your machine. Open ace to answer.", hostId: hostId)
        }
        await releaseTransient()
    }
    func resolve(threadId: String, interactionId: String, optionId: String, hostId: String? = nil) async -> NotificationPatch.ActionOutcome? {
        guard let model = await session(hostId, budget: .seconds(10)) else { return .unreachable }
        // A view-only pairing answers nothing; the person answers on the computer.
        guard model.canOperate else { return .refused }
        let requestId = makeId()
        let outcome = Waiter<NotificationPatch.ActionOutcome>()
        expect(requestId, outcome)
        guard model.notificationAction(["type": "notifications.resolve", "requestId": requestId, "threadId": threadId,
                                         "interactionId": interactionId, "optionId": optionId]) else { return .unreachable }
        return await outcome.wait(.seconds(15), sleep: sleep) ?? outcome.latest
    }
    /// BGAppRefreshTask: connect every paired machine briefly, fetch what a suspended app missed
    /// from each at once, then let go. True when every reachable machine caught up in the budget.
    func backgroundCatchUp() async -> Bool {
        if permission == .unknown { await refreshPermission() }
        guard delivering else { return true }
        if machines.isEmpty { transient = await connectInBackground(self) }
        let ready = await readyMachines(within: .seconds(10))
        guard !ready.isEmpty else { await releaseTransient(); return false }
        var waiters: [Waiter<Bool>] = []
        for entry in ready {
            let waiter = Waiter<Bool>()
            expectFeed(waiter, from: entry.hostId)
            waiters.append(waiter)
        }
        sync()
        var caught = true
        for waiter in waiters { caught = await waiter.wait(.seconds(10), sleep: sleep) == true && caught }
        await releaseTransient()
        return caught && ready.count == machines.count
    }
    /// The machine's attached connection, or a short-lived one to every paired machine. Nil unless
    /// that machine (the first, when none is named) is ready within the budget.
    func session(_ hostId: String? = nil, budget: Duration) async -> ClientModel? {
        if machines.isEmpty { transient = await connectInBackground(self) }
        guard let current = client(hostId) ?? (hostId == nil ? nil : transient.first) else { return nil }
        if current.connection != "ready" { current.retry() }
        var waited = Duration.zero
        while current.connection != "ready", waited < budget {
            await sleep(.milliseconds(100))
            waited += .milliseconds(100)
        }
        return current.connection == "ready" ? current : nil
    }
    /// Every attached machine that is ready within one shared budget; slow ones don't hold up the rest.
    private func readyMachines(within budget: Duration) async -> [(hostId: String, model: ClientModel, notifier: LocalNotifier)] {
        for entry in machines where entry.model.connection != "ready" { entry.model.retry() }
        var waited = Duration.zero
        while machines.contains(where: { $0.model.connection != "ready" }), waited < budget {
            await sleep(.milliseconds(100))
            waited += .milliseconds(100)
        }
        return machines.filter { $0.model.connection == "ready" }
    }
    func releaseTransient() async {
        let models = transient
        transient = []
        for model in models {
            detach(model)
            await model.disconnectAndWait()
        }
    }
    /// While the user looks at a thread, its own alerts stay out of the way; an alert whose
    /// banner is off (Settings › Notifications) goes to the list without showing over the app.
    func presentation(for threadId: String?, hostId: String? = nil, banner: Bool = true) -> UNNotificationPresentationOptions {
        if foreground, let threadId, machines.contains(where: { ($0.hostId == hostId || hostId == nil) && $0.model.thread?.id == threadId }) { return [] }
        return banner ? [.banner, .list, .sound] : [.list]
    }
}
