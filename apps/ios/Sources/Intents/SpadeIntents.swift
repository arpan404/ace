import AppIntents
import Foundation
import NaturalLanguage
import Observation

/// Siri's Ask Spade, as rules (ADR 0134, amendment 2026-11-22): which machine the words go to,
/// the one sentence when none can take them, and what Siri says back. The machine is the one the
/// fleet chose to host Spade, as the Spade tab elects it (`SpadeRoster`); the words never go to
/// another machine's Spade instead. Pure.
enum SpadeAsk {
    /// One paired machine, and its answer to `spade.main.read`; nil when it couldn't be reached.
    struct Reach: Equatable, Sendable {
        /// The phone's host id for it.
        let key: String
        let name: String
        let answer: Answer?
    }
    struct Answer: Equatable, Sendable {
        /// Its ace host id, as host records name it.
        var here: String?
        /// The host choice it holds, whether or not its own Spade can take words.
        var record: SpadeModel.HostRecord?
        /// Its main Spade, when that can take words.
        var spade: Main?
        /// Why it can't, in its own sentence.
        var problem: String?
    }
    struct Main: Equatable, Sendable {
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
        /// Sent, but the answer was lost on the way back: the reply is Spade's conversation's.
        case sentUnconfirmed
        case refused(String)
    }

    static func choose(_ machines: [Reach]) -> Choice {
        guard !machines.isEmpty else { return .cannot("Pair a computer with ace first, then ask Spade again.") }
        let reached = machines.compactMap { reach in reach.answer.map { (reach: reach, answer: $0) } }
        // The newest choice any machine holds, whether or not its own Spade answers.
        if let choice = SpadeRoster.newest(reached.compactMap { $0.answer.record }) {
            if let host = reached.first(where: { ($0.answer.here ?? $0.reach.key) == choice.host }) {
                guard let spade = host.answer.spade else {
                    return .cannot(host.answer.problem ?? "Spade isn't answering on its computer right now.")
                }
                return .send(machine: host.reach.key, conversation: spade.conversation, after: spade.after)
            }
            let name = machines.first { $0.key == choice.host }?.name
            return .cannot(name.map { "Spade's computer, \($0), can't be reached right now, so Spade didn't get that." }
                ?? "The computer Spade runs on can't be reached right now, so Spade didn't get that.")
        }
        // No choice yet: the oldest Spade answering, the lower host id on a tie, as the tab shows.
        let answering = reached.compactMap { each in each.answer.spade.map { (id: each.answer.here ?? each.reach.key, key: each.reach.key, spade: $0) } }
        let oldest = answering.min { a, b in
            a.spade.createdAt != b.spade.createdAt ? a.spade.createdAt < b.spade.createdAt : a.id.utf16.lexicographicallyPrecedes(b.id.utf16)
        }
        if let oldest { return .send(machine: oldest.key, conversation: oldest.spade.conversation, after: oldest.spade.after) }
        if let problem = reached.lazy.compactMap(\.answer.problem).first { return .cannot(problem) }
        return .cannot("None of your computers can be reached right now, so Spade didn't get that.")
    }

    /// What Siri says: the first sentence of the reply, plain, or where the reply will be.
    static func said(_ outcome: Outcome) -> String {
        switch outcome {
        case let .replied(text):
            return firstSentence(text) ?? "Spade is done. Its reply is in ace."
        case let .pending(notifies):
            return notifies ? "Spade is on it. Its reply will come as a notification." : "Spade is on it. Its reply will be in ace."
        case .sentUnconfirmed:
            return "Sent to Spade. Its reply will be in ace."
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

/// The Action button and Control Center: ace comes to the front on Spade's conversation,
/// recording. Only this intent can start the recorder (`SpadeTalkHandoff`); no link can.
struct TalkToSpadeIntent: AppIntent {
    static let title: LocalizedStringResource = "Talk to Spade"
    static let description = IntentDescription("Opens Spade with the microphone recording.")
    static let openAppWhenRun = true
    @Dependency private var talk: SpadeTalkHandoff

    @MainActor func perform() async throws -> some IntentResult {
        talk.ask()
        return .result()
    }
}

/// Talk to Spade's hand-off inside the app: the intent asks, the inbox takes it once and opens
/// the main Spade recording. In-process only, so nothing outside the app can start the mic.
@MainActor @Observable final class SpadeTalkHandoff {
    /// Bumped by each ask, for the inbox to notice one.
    private(set) var asks = 0
    private var waiting = false
    func ask() {
        waiting = true
        asks += 1
    }
    /// Whether an ask waits, once: taking it clears it.
    func take() -> Bool {
        defer { waiting = false }
        return waiting
    }
}
