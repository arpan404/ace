import Foundation
import UIKit
import UserNotifications

/// A machine's answer to `spade.main.read`, `spade.ask` and `spade.reply` (`bridge/spade-ask.ts`).
private struct SpadeAskWire: Decodable, Sendable {
    let ok: Bool
    let message: String?
    let here: String?
    let record: SpadeModel.HostRecord?
    let conversationId: String?
    let problem: String?
    let createdAt: Double?
    let after: Int?
    /// The asked message's event, which the reply is waited on by.
    let asked: Int?
    let reply: String?
}

/// Ask Spade through the phone's machines: those the app already holds, or short-lived ones a
/// background launch opens, held for as long as this ask needs them (`holdTransient`).
@MainActor struct SpadeAskRun {
    let coordinator: NotificationCoordinator
    /// Siri waits about this long for the whole answer.
    private static let siriTime: Duration = .seconds(20)
    /// Finding where Spade lives, connections and reads together.
    private static let findTime: Duration = .seconds(6)

    func ask(_ words: String) async -> String {
        let started = ContinuousClock.now
        await coordinator.holdTransient()
        let choice = SpadeAsk.choose(await reach(by: started + Self.findTime))
        guard case let .send(machine, conversation, after) = choice, let client = coordinator.client(machine) else {
            await coordinator.letGoTransient()
            if case let .cannot(sentence) = choice { return sentence }
            return "Spade's computer can't be reached right now, so Spade didn't get that."
        }
        let wait = max(2_000, Int((Self.siriTime - (ContinuousClock.now - started)).components.seconds) * 1_000)
        let payload: [String: Any] = ["type": "spade.ask", "conversationId": conversation, "after": after, "text": words, "waitMs": wait]
        let sent: SpadeAskWire
        do {
            sent = try await client.service(payload, as: SpadeAskWire.self, timeout: .milliseconds(wait + 15_000))
        } catch {
            // The bridge had the words and may have sent them before its answer was lost.
            await coordinator.letGoTransient()
            return SpadeAsk.said(.sentUnconfirmed)
        }
        guard sent.ok else {
            await coordinator.letGoTransient()
            return SpadeAsk.said(.refused(sent.message ?? "Spade didn't get that. Try again."))
        }
        if let reply = sent.reply {
            await coordinator.letGoTransient()
            return SpadeAsk.said(.replied(reply))
        }
        guard let asked = sent.asked else {
            await coordinator.letGoTransient()
            return SpadeAsk.said(.sentUnconfirmed)
        }
        guard coordinator.delivering else {
            await coordinator.letGoTransient()
            return SpadeAsk.said(.pending(notifies: false))
        }
        // Past Siri's time: wait on while iOS lets the app run; the follow lets go of the hold.
        SpadeReplyFollow(coordinator: coordinator).start(client, conversation: conversation, asked: asked)
        return SpadeAsk.said(.pending(notifies: true))
    }

    /// Every paired machine's answer about where Spade lives, connections and reads all by `deadline`.
    private func reach(by deadline: ContinuousClock.Instant) async -> [SpadeAsk.Reach] {
        let machines = coordinator.machines
        for entry in machines where entry.model.connection != "ready" { entry.model.retry() }
        // Leave the reads their share of the budget.
        while machines.contains(where: { $0.model.connection != "ready" }), ContinuousClock.now < deadline - .seconds(2) {
            try? await Task.sleep(for: .milliseconds(100))
        }
        // One main-actor task per machine: they wait on their reads side by side, each bounded by
        // `deadline`. A task group's `addTask { @MainActor in }` here trips Swift 6's region checker.
        let reads = machines.map { entry in
            let key = entry.hostId
            let name = coordinator.machineName(key) ?? key
            let client = entry.model
            let ready = client.connection == "ready"
            return Task { await Self.read(client, key: key, name: name, ready: ready, by: deadline) }
        }
        var answers: [SpadeAsk.Reach] = []
        for read in reads { answers.append(await read.value) }
        return answers
    }

    /// One machine's answer about where Spade lives, or none when it isn't ready or misses `deadline`.
    private static func read(_ client: ClientModel, key: String, name: String, ready: Bool,
                             by deadline: ContinuousClock.Instant) async -> SpadeAsk.Reach {
        let left = deadline - ContinuousClock.now
        guard ready, left > .zero,
              let answer = try? await client.service(["type": "spade.main.read"], as: SpadeAskWire.self, timeout: left) else {
            return .init(key: key, name: name, answer: nil)
        }
        guard answer.ok else { return .init(key: key, name: name, answer: .init(problem: answer.message)) }
        let spade = answer.conversationId.map {
            SpadeAsk.Main(conversation: $0, createdAt: answer.createdAt ?? 0, after: answer.after ?? 0)
        }
        return .init(key: key, name: name,
                     answer: .init(here: answer.here, record: answer.record, spade: spade, problem: answer.problem))
    }
}

/// The reply past Siri's time: waited on in a background task while iOS gives the app time, then
/// posted as a notification. Time running out says so in a notification too, and ends the task.
@MainActor private final class SpadeReplyFollow {
    private let coordinator: NotificationCoordinator
    private var background: UIBackgroundTaskIdentifier = .invalid
    private var work: Task<Void, Never>?
    private var posted = false
    private static let stillOn = "Spade is still working on that. Its reply will be in ace."

    init(coordinator: NotificationCoordinator) { self.coordinator = coordinator }

    func start(_ client: ClientModel, conversation: String, asked: Int) {
        background = UIApplication.shared.beginBackgroundTask(withName: "Spade reply") { [self] in
            MainActor.assumeIsolated { expire() }
        }
        work = Task { await wait(client, conversation: conversation, asked: asked) }
    }

    private func wait(_ client: ClientModel, conversation: String, asked: Int) async {
        while !Task.isCancelled {
            // Each wait ends well before iOS's time does, so the last word still goes.
            let left = UIApplication.shared.backgroundTimeRemaining - 8
            let waitMs = Int(min(25, left) * 1_000)
            guard waitMs >= 1_000 else { break }
            let payload: [String: Any] = ["type": "spade.reply", "conversationId": conversation, "asked": asked, "waitMs": waitMs]
            guard let answer = try? await client.service(payload, as: SpadeAskWire.self, timeout: .milliseconds(waitMs + 10_000)) else { break }
            guard answer.ok else { post(answer.message ?? Self.stillOn); return finish() }
            if let reply = answer.reply { post(SpadeAsk.plain(reply)); return finish() }
        }
        if !Task.isCancelled { post(Self.stillOn) }
        finish()
    }

    /// iOS's time is up: the person hears where the reply will be, and the task ends at once.
    private func expire() {
        work?.cancel()
        post(Self.stillOn)
        finish()
    }

    private func finish() {
        guard background != .invalid else { return }
        UIApplication.shared.endBackgroundTask(background)
        background = .invalid
        let coordinator = coordinator
        Task { await coordinator.letGoTransient() }
    }

    /// One notification per ask, handed to the system at once (no waiting at expiry).
    private func post(_ body: String) {
        guard !posted else { return }
        posted = true
        let content = UNMutableNotificationContent()
        content.title = "Spade"
        content.body = String(body.prefix(1_000))
        content.threadIdentifier = "spade"
        content.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "spade-ask-\(UUID().uuidString)", content: content, trigger: nil))
    }
}
