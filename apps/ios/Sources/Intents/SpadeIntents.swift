import AppIntents
import Foundation
import NaturalLanguage
import UIKit
import UserNotifications

/// Siri's Ask Spade, as rules (ADR 0134, amendment 2026-11-22): which machine the words go to,
/// the one sentence when none can take them, and what Siri says back. The machine is the one the
/// fleet chose to host Spade, as the Spade tab elects it (`SpadeRoster`); the words never go to
/// another machine's Spade instead. Pure.
enum SpadeAsk {
    /// One paired machine, as it answered `spade.main.read`.
    struct Reach: Equatable, Sendable {
        /// The phone's host id for it.
        let key: String
        let name: String
        /// Where its Spade says Spade lives; nil when it couldn't be reached or refused.
        let main: Main?
        /// Why its Spade can't answer, in its own sentence, when it was reached.
        let refusal: String?
    }
    struct Main: Equatable, Sendable {
        let here: String?
        let record: SpadeModel.HostRecord?
        let conversation: String
        let createdAt: Double
        /// The conversation's events up to here came before the question.
        let after: Int
    }
    enum Choice: Equatable, Sendable {
        case send(machine: String, conversation: String, after: Int)
        /// Nothing is sent: Siri says why.
        case cannot(String)
    }
    enum Outcome: Equatable, Sendable {
        case replied(String)
        /// The reply didn't come in Siri's time; `notifies` when a notification can carry it.
        case pending(notifies: Bool)
        case refused(String)
    }

    static func choose(_ machines: [Reach]) -> Choice {
        guard !machines.isEmpty else { return .cannot("Pair a computer with ace first, then ask Spade again.") }
        let answering = machines.compactMap { reach in reach.main.map { (reach: reach, main: $0) } }
        if let choice = SpadeRoster.newest(answering.compactMap { $0.main.record }) {
            if let host = answering.first(where: { ($0.main.here ?? $0.reach.key) == choice.host }) {
                return .send(machine: host.reach.key, conversation: host.main.conversation, after: host.main.after)
            }
            let name = machines.first { $0.key == choice.host }?.name
            return .cannot(name.map { "Spade's computer, \($0), can't be reached right now, so Spade didn't get that." }
                ?? "The computer Spade runs on can't be reached right now, so Spade didn't get that.")
        }
        // No choice yet: the oldest Spade answering, the lower host id on a tie, as the tab shows.
        let oldest = answering.min { a, b in
            a.main.createdAt != b.main.createdAt ? a.main.createdAt < b.main.createdAt
                : (a.main.here ?? a.reach.key).utf16.lexicographicallyPrecedes((b.main.here ?? b.reach.key).utf16)
        }
        if let oldest { return .send(machine: oldest.reach.key, conversation: oldest.main.conversation, after: oldest.main.after) }
        if let refusal = machines.lazy.compactMap(\.refusal).first { return .cannot(refusal) }
        return .cannot("None of your computers can be reached right now, so Spade didn't get that.")
    }

    /// What Siri says: the first sentence of the reply, plain, or where the reply will be.
    static func said(_ outcome: Outcome) -> String {
        switch outcome {
        case let .replied(text):
            return firstSentence(text) ?? "Spade is done. Its reply is in ace."
        case let .pending(notifies):
            return notifies ? "Spade is on it. Its reply will come as a notification." : "Spade is on it. Its reply will be in ace."
        case let .refused(sentence):
            return sentence
        }
    }

    /// The reply as words to read: links as their text, Markdown's marks gone.
    static func plain(_ text: String) -> String {
        text.replacingOccurrences(of: #"\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: #"[*_`#>~]+"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The first sentence of `text` as plain words; nil when it says nothing.
    static func firstSentence(_ text: String) -> String? {
        let words = plain(text)
        guard !words.isEmpty else { return nil }
        let line = String(words.prefix { !$0.isNewline })
        let tokenizer = NLTokenizer(unit: .sentence)
        tokenizer.string = line
        var first: String?
        tokenizer.enumerateTokens(in: line.startIndex..<line.endIndex) { range, _ in
            first = String(line[range]).trimmingCharacters(in: .whitespacesAndNewlines)
            return false
        }
        return first.flatMap { $0.isEmpty ? nil : $0 } ?? line
    }
}

/// A machine's answer to `spade.main.read`, `spade.ask` and `spade.reply` (`bridge/spade-ask.ts`).
private struct SpadeAskWire: Decodable, Sendable {
    let ok: Bool
    let message: String?
    let here: String?
    let record: SpadeModel.HostRecord?
    let conversationId: String?
    let createdAt: Double?
    let after: Int?
    let reply: String?
}

/// Ask Spade through the phone's machines: those the app already holds, or short-lived ones a
/// background launch opens (`NotificationCoordinator.connectInBackground`), released after.
@MainActor struct SpadeAskRun {
    let coordinator: NotificationCoordinator
    /// Siri waits about this long for the whole answer.
    private static let siriTime: Duration = .seconds(20)

    func ask(_ words: String) async -> String {
        let started = ContinuousClock.now
        let opened = coordinator.machines.isEmpty
        if opened { coordinator.transient = await coordinator.connectInBackground(coordinator) }
        let question: Question
        switch SpadeAsk.choose(await reach(within: .seconds(6))) {
        case let .cannot(sentence):
            await release(opened)
            return sentence
        case let .send(machine, conversation, after):
            question = Question(machine: machine, conversation: conversation, after: after, text: words)
        }
        let left = Self.siriTime - (ContinuousClock.now - started)
        let wait = max(2_000, Int(left.components.seconds) * 1_000)
        guard let client = coordinator.client(question.machine),
              let answer = await request(client, question.payload("spade.ask", waitMs: wait)) else {
            await release(opened)
            return SpadeAsk.said(.refused("Spade didn't get that. Try again."))
        }
        guard answer.ok else {
            await release(opened)
            return SpadeAsk.said(.refused(answer.message ?? "Spade didn't get that. Try again."))
        }
        if let reply = answer.reply {
            await release(opened)
            return SpadeAsk.said(.replied(reply))
        }
        let notifies = coordinator.delivering
        // Past Siri's time: wait on while iOS lets the app run, then post the reply.
        Task {
            if notifies { await follow(client, question) }
            await release(opened)
        }
        return SpadeAsk.said(.pending(notifies: notifies))
    }

    /// The words and where they went, for the requests that wait on the reply.
    private struct Question: Sendable {
        let machine: String
        let conversation: String
        let after: Int
        let text: String
        func payload(_ type: String, waitMs: Int) -> [String: Any] {
            ["type": type, "conversationId": conversation, "after": after, "text": text, "waitMs": waitMs]
        }
    }

    /// Short-lived connections this run opened close again.
    private func release(_ opened: Bool) async {
        if opened { await coordinator.releaseTransient() }
    }

    /// Every paired machine's answer about where Spade lives, read at once within `budget`.
    private func reach(within budget: Duration) async -> [SpadeAsk.Reach] {
        let machines = coordinator.machines
        for entry in machines where entry.model.connection != "ready" { entry.model.retry() }
        let deadline = ContinuousClock.now + budget
        while machines.contains(where: { $0.model.connection != "ready" }), ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(100))
        }
        var reaches: [SpadeAsk.Reach] = []
        await withTaskGroup(of: (Int, SpadeAsk.Reach).self) { group in
            for (index, entry) in machines.enumerated() {
                let key = entry.hostId
                let name = coordinator.machineName(key) ?? key
                let ready = entry.model.connection == "ready"
                let client = entry.model
                group.addTask { @MainActor in
                    guard ready, let answer = await request(client, ["type": "spade.main.read"]) else {
                        return (index, .init(key: key, name: name, main: nil, refusal: nil))
                    }
                    guard answer.ok, let conversation = answer.conversationId else {
                        return (index, .init(key: key, name: name, main: nil, refusal: answer.message))
                    }
                    let main = SpadeAsk.Main(here: answer.here, record: answer.record, conversation: conversation,
                                             createdAt: answer.createdAt ?? 0, after: answer.after ?? 0)
                    return (index, .init(key: key, name: name, main: main, refusal: nil))
                }
            }
            var byIndex: [Int: SpadeAsk.Reach] = [:]
            for await (index, reach) in group { byIndex[index] = reach }
            reaches = machines.indices.compactMap { byIndex[$0] }
        }
        return reaches
    }

    /// Waits on in the background, while iOS gives the app time, and posts the reply.
    private func follow(_ client: ClientModel, _ question: Question) async {
        let task = UIApplication.shared.beginBackgroundTask(withName: "Spade reply") {}
        defer { UIApplication.shared.endBackgroundTask(task) }
        for _ in 0..<6 where UIApplication.shared.backgroundTimeRemaining > 30 || UIApplication.shared.applicationState == .active {
            guard let answer = await request(client, question.payload("spade.reply", waitMs: 25_000)), answer.ok else { return }
            guard let reply = answer.reply else { continue }
            await post(reply)
            return
        }
    }

    private func post(_ reply: String) async {
        let content = UNMutableNotificationContent()
        content.title = "Spade"
        content.body = String(SpadeAsk.plain(reply).prefix(1_000))
        content.threadIdentifier = "spade"
        content.sound = .default
        let request = UNNotificationRequest(identifier: "spade-ask-\(UUID().uuidString)", content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }

    private func request(_ client: ClientModel, _ payload: [String: Any]) async -> SpadeAskWire? {
        try? await client.service(payload, as: SpadeAskWire.self, timeout: .seconds(40))
    }
}

/// "Ask Spade …", "Tell Spade …": the words go to the main Spade, and Siri reads back the first
/// sentence of its reply, or says Spade is on it.
struct AskSpadeIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Spade"
    static let description = IntentDescription("Sends what you say to Spade and reads back its answer.")
    static let openAppWhenRun = false

    @Parameter(title: "Message", inputOptions: String.IntentInputOptions(multiline: true), requestValueDialog: "What should Spade do?")
    var words: String
    @Dependency private var coordinator: NotificationCoordinator

    static var parameterSummary: some ParameterSummary { Summary("Ask Spade \(\.$words)") }

    @MainActor func perform() async throws -> some IntentResult & ProvidesDialog {
        let words = words.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { throw $words.needsValueError() }
        let said = await SpadeAskRun(coordinator: coordinator).ask(words)
        return .result(dialog: "\(said)")
    }
}

/// The Action button and Control Center: ace opens on Spade's conversation, recording.
struct TalkToSpadeIntent: AppIntent {
    static let title: LocalizedStringResource = "Talk to Spade"
    static let description = IntentDescription("Opens Spade with the microphone recording.")
    static let openAppWhenRun = false

    @MainActor func perform() async throws -> some IntentResult & OpensIntent {
        .result(opensIntent: OpenURLIntent(SpadeTalkLink.url))
    }
}

/// `ace://spade/talk`: the Spade tab opens the main Spade, its recorder already recording.
enum SpadeTalkLink {
    static var url: URL {
        var components = URLComponents()
        components.scheme = AceLink.scheme
        components.host = "spade"
        components.path = "/talk"
        return components.url ?? URL(fileURLWithPath: "/")
    }
}
