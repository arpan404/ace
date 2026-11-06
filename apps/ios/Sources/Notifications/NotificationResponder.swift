import Foundation
import UserNotifications

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
    /// a choice the exact option the question offered, and Reply sends the words, each on the
    /// machine that raised it and only after reading the request's current state (ADR 0012); a
    /// notification grants no authority. Every answer ends in an honest word: withdrawn once the
    /// machine confirms it, otherwise a quiet follow-up saying what happened.
    func respond(action: String, notificationId: String, info: [String: String], text: String? = nil) async {
        guard let threadId = info[NotificationKeys.threadId] else { return }
        let hostId = info[NotificationKeys.hostId]
        guard let answer = NotificationAnswer(action: action, info: info, text: text) else {
            if let model = client(hostId) { model.deepLink = threadId } else { pendingLink = (threadId, hostId) }
            return
        }
        let outcome = await perform(answer, threadId: threadId, hostId: hostId)
        await report(outcome, for: answer, notificationId: notificationId, threadId: threadId, hostId: hostId)
        await releaseTransient()
    }
    /// Sends one answer through the machine's bridge and waits for what became of it.
    func perform(_ answer: NotificationAnswer, threadId: String, hostId: String?) async -> NotificationPatch.ActionOutcome? {
        guard let model = await session(hostId, budget: .seconds(10)) else { return .unreachable }
        // A view-only pairing answers nothing; the person answers on the computer.
        guard model.canOperate else { return .refused }
        let requestId = makeId()
        let outcome = Waiter<NotificationPatch.ActionOutcome>()
        expect(requestId, outcome)
        guard model.notificationAction(answer.action(requestId: requestId, threadId: threadId)) else { return .unreachable }
        return await outcome.wait(.seconds(15), sleep: sleep) ?? outcome.latest
    }
    /// Kept for the Live Activity's Allow/Deny and older callers.
    func resolve(threadId: String, interactionId: String, optionId: String, hostId: String? = nil) async -> NotificationPatch.ActionOutcome? {
        await perform(.option(interactionId: interactionId, optionId: optionId), threadId: threadId, hostId: hostId)
    }
    /// Confirmed: the alert goes. Anything else: a quiet notice in its place, saying what happened.
    func report(_ outcome: NotificationPatch.ActionOutcome?, for answer: NotificationAnswer, notificationId: String,
                threadId: String, hostId: String?) async {
        if outcome == .confirmed || outcome == .stale {
            notifier.withdraw(notificationId)
            desk.clear(threadId: threadId, hostId: hostId)
        }
        guard let words = ActionNotice.words(outcome, for: answer) else { return }
        await notifier.notice(id: "action:\(notificationId)", threadId: threadId, title: words.title, body: words.body, hostId: hostId)
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
