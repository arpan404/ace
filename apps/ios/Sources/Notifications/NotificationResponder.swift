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
        let foregroundName = coordinator.machineName
        let machines = ProductionApp.machines(directory: directory, notifications: coordinator, now: coordinator.now)
        coordinator.machineName = { [weak machines] in foregroundName($0) ?? machines?.inbox.names[$0] }
        coordinator.transientDirectory = machines
        await machines.openInBackground()
        return machines.inbox.all.map(\.client)
    }
}

extension NotificationCoordinator {
    /// Tap opens the thread on its machine. Allow/Deny answer the exact option the daemon offered,
    /// a choice the exact option the question offered, and Reply sends the words, each on the
    /// machine that raised it and only after reading the request's current state (ADR 0012); a
    /// notification grants no authority. Every answer ends in an honest word: withdrawn once the
    /// machine confirms it, otherwise a quiet follow-up saying what happened.
    func respond(action: String, notificationId: String, info: [String: String], text: String? = nil) async {
        // An outside app's sign-in: the tap opens its sheet; it has no buttons to answer.
        if let access = AccessAlert(info: info) {
            openAccess(access, hostId: info[NotificationKeys.hostId])
            return
        }
        guard let threadId = info[NotificationKeys.threadId] else { return }
        let hostId = info[NotificationKeys.hostId]
        guard let answer = NotificationAnswer(action: action, info: info, text: text) else {
            if let model = client(hostId) { model.deepLink = threadId } else { pendingLink = (threadId, hostId) }
            return
        }
        let outcome = await perform(answer, threadId: threadId, hostId: hostId)
        await report(outcome, for: answer, notificationId: notificationId, threadId: threadId, hostId: localNotificationHost(hostId))
        await releaseTransient()
    }
    /// Sends one answer through the machine's bridge and waits for what became of it.
    func perform(_ answer: NotificationAnswer, threadId: String, hostId: String?) async -> NotificationPatch.ActionOutcome? {
        await holdTransient()
        guard let model = await session(hostId, budget: .seconds(10)) else {
            await letGoTransient()
            return .unreachable
        }
        let result = await perform(answer, threadId: threadId, on: model)
        await letGoTransient()
        return result
    }
    private func perform(_ answer: NotificationAnswer, threadId: String, on model: ClientModel) async -> NotificationPatch.ActionOutcome? {
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
    /// Both iOS wake sources share one run and one time budget across every machine. A wake that
    /// joins it and is cancelled (iOS took its time back) stops it too. Neither wake's report
    /// waits on it past that wake's own deadline (`OSCompletion`).
    func backgroundCatchUp() async -> Bool {
        if let refresh = backgroundWork {
            return await withTaskCancellationHandler { await refresh.value } onCancel: { refresh.cancel() }
        }
        let refresh = Task { @MainActor in
            await runBackgroundCatchUp()
        }
        backgroundWork = refresh
        let caught = await withTaskCancellationHandler { await refresh.value } onCancel: { refresh.cancel() }
        backgroundWork = nil
        return caught
    }
    private func runBackgroundCatchUp() async -> Bool {
        let budget = Task { @MainActor in
            await sleep(.seconds(18))
            guard !Task.isCancelled else { return }
            backgroundWork?.cancel()
        }
        defer { budget.cancel() }
        transientHolds += 1
        let caught = await fetchInBackground()
        await letGoTransient()
        return caught
    }
    private func fetchInBackground() async -> Bool {
        if permission == .unknown { await refreshPermission() }
        guard !Task.isCancelled else { return false }
        guard delivering || liveActivity else { return true }
        await openTransient()
        let entries = machines
        guard !Task.isCancelled, !entries.isEmpty else { return false }
        let alerts = entries.filter { delivering($0.hostId) }
        let waiters = alerts.map { entry in
            let waiter = Waiter<Bool>()
            expectFeed(waiter, from: entry.hostId)
            return (entry.hostId, waiter)
        }
        defer { for (host, waiter) in waiters { stopExpectingFeed(waiter, from: host) } }
        for entry in entries { entry.model.wake() }
        sync()
        while !Task.isCancelled {
            let screenReady = !liveActivity || entries.allSatisfy { $0.model.inboxConfirmed }
            if screenReady && waiters.allSatisfy({ $0.1.finished }) {
                lockScreen.rebuild()
                await lockScreen.settle()
                return waiters.allSatisfy { $0.1.value == true }
            }
            await sleep(.milliseconds(100))
        }
        return false
    }
    /// Only the authenticated machine named by the alert can answer it.
    func session(_ hostId: String? = nil, budget: Duration) async -> ClientModel? {
        await openTransient()
        guard !machines.isEmpty else { return nil }
        var waited = Duration.zero
        var woken: ClientModel?
        while !Task.isCancelled, waited < budget {
            if let current = client(hostId) {
                if current.connection == "ready" { return current }
                if current !== woken { current.wake(); woken = current }
            }
            await sleep(.milliseconds(100))
            waited += .milliseconds(100)
        }
        return nil
    }
    /// Opens short-lived connections to every paired machine when none is attached, once however
    /// many callers ask at the same time.
    func openTransient() async {
        let opening: Task<Void, Never>
        if let existing = transientOpening {
            opening = existing
        } else {
            guard machines.isEmpty, !Task.isCancelled else { return }
            opening = Task { @MainActor in
                transient = await BackgroundOpening.$active.withValue(true) { await connectInBackground(self) }
                transientOpening = nil
            }
            transientOpening = opening
        }
        await withTaskCancellationHandler { await opening.value } onCancel: {
            Task { @MainActor in
                if self.transientHolds == 1 { opening.cancel() }
            }
        }
    }
    /// Opens the short-lived connections, or joins those open, and keeps them until `letGoTransient`.
    func holdTransient() async {
        transientHolds += 1
        await openTransient()
    }
    func letGoTransient() async {
        transientHolds = max(0, transientHolds - 1)
        await releaseTransient()
    }
    /// The short-lived connections close, unless a caller still holds them.
    func releaseTransient() async {
        guard transientHolds == 0 else { return }
        await closeTransient()
    }
    func closeTransient() async {
        transientDirectory?.stopBackgroundRoutes()
        transientDirectory = nil
        let models = transient
        transient = []
        for model in models { releaseBackgroundMachine(model) }
        for model in models { await model.disconnectAndWait() }
    }
    /// While the user looks at a thread, its own alerts stay out of the way; an alert whose
    /// banner is off (Settings › Notifications) goes to the list without showing over the app.
    func presentation(for threadId: String?, hostId: String? = nil, banner: Bool = true) -> UNNotificationPresentationOptions {
        let hostId = localNotificationHost(hostId)
        // A machine turned off on this phone shows nothing, even a notification already on its way.
        if let hostId, MachinesModel.turnedOff(in: defaults).contains(hostId) { return [] }
        if foreground, let threadId, machines.contains(where: { ($0.hostId == hostId || hostId == nil) && $0.model.thread?.id == threadId }) { return [] }
        return banner ? [.banner, .list, .sound] : [.list]
    }
}

/// Set while `connectInBackground` attaches the runtimes it opens, so their attach doesn't wait on
/// the opening it is part of.
enum BackgroundOpening {
    @TaskLocal static var active = false
}
