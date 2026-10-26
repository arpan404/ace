import Foundation
import Observation

/// Where a composer's lists come from: an open thread, or New thread's project and agent.
enum SuggestScope: Equatable, Sendable {
    case thread(String)
    case draft(workspaceId: String, provider: String?)
    /// The name the bridge echoes on each list (`composer-suggest.ts`).
    var key: String {
        switch self {
        case .thread(let id): "thread:\(id)"
        case .draft(let workspaceId, let provider): "draft:\(workspaceId):\(provider ?? "")"
        }
    }
    var json: [String: Any] {
        switch self {
        case .thread(let id): ["type": "thread", "threadId": id]
        case .draft(let workspaceId, let provider):
            provider.map { ["type": "draft", "workspaceId": workspaceId, "provider": $0] } ?? ["type": "draft", "workspaceId": workspaceId]
        }
    }
}

/// A change to the message the composer makes itself: the words and where the caret goes.
struct ComposerEdit: Equatable {
    let text: String
    let caret: Int
    /// The reference the edit inserted, to keep with the words once they changed.
    var pick: ComposerPick? = nil
}

/// What picking a row asks of the screen around the composer.
enum ComposerPickOutcome: Equatable {
    /// Words changed (a reference inserted, `/goal ` written, `@` opened).
    case edit(ComposerEdit)
    /// A builtin the screen runs: attach, plan, model, review, project, attachments.
    case run(String, ComposerEdit?)
    /// A prompt that needs its arguments first.
    case arguments(SuggestionRow)
    /// Why the pick can't be made.
    case notice(String)
}

/// One composer's `@` and `/` lists: the word at the caret becomes a query (only when it changes),
/// the bridge answers, and a pick becomes an edit or an action, by the web's rules. The bridge
/// does the reading, filtering and grouping; this keeps the caret's word. Picks live with the
/// composer's draft (`ComposerPicks`).
@MainActor @Observable final class ComposerSuggester {
    @ObservationIgnored private static var sequence = 0
    var scope: SuggestScope?
    private(set) var trigger: ComposerTrigger?
    private(set) var seq = -1
    /// Whether this composer is the one on screen: a composer being left drops its late caret
    /// reports, so they never cancel the list of the one taking its place.
    var active = false {
        didSet {
            guard active != oldValue, !active else { return }
            trigger = nil
            dismissed = nil
        }
    }
    /// A prompt asking for its arguments, and the word it will replace.
    var asking: (row: SuggestionRow, trigger: ComposerTrigger?)?
    /// The word Esc or tapping away closed: it stays closed until the person types elsewhere.
    @ObservationIgnored private var dismissed: Int?
    @ObservationIgnored private weak var model: ClientModel?
    @ObservationIgnored private var text = ""
    @ObservationIgnored private var held: [String: Int] = [:]
    /// Where the caret last was, as a UTF-16 offset.
    @ObservationIgnored private(set) var caret = 0

    func attach(_ model: ClientModel?) { self.model = model }

    /// The list on screen for this composer's word, while one is open.
    var shown: SuggestionList? {
        guard trigger != nil, let scope, let list = model?.suggestions.list, list.scope == scope.key, list.seq == seq else { return nil }
        return list
    }
    /// The + list's rows for this composer (builtins only).
    var adding: [SuggestionRow] {
        guard let scope, let list = model?.suggestions.add, list.scope == scope.key else { return [] }
        return list.rows
    }

    /// Read the catalog and the + list ahead, so `/` and + open on rows.
    func readAhead() {
        guard active, let model, let scope else { return }
        model.action(["type": "suggest", "action": ["kind": "prefetch", "scope": scope.json]])
        Self.sequence += 1
        model.action(["type": "suggest", "action": ["kind": "query", "scope": scope.json, "list": "add", "query": "", "seq": Self.sequence]])
    }

    /// The words or caret moved: ask for the word's list when it changed. `held` is what the
    /// message's picks hold, for the per-message limits.
    func caretMoved(text: String, caret: Int, held: [String: Int]) {
        guard active else { return }
        self.text = text
        self.held = held
        self.caret = caret
        var found = ComposerTrigger.at(text, caret: caret)
        if let word = found, word.start == dismissed { found = nil } else { dismissed = nil }
        // Without a scope (a chat with no project) there is nothing to suggest.
        guard let model, let scope else { trigger = nil; return }
        guard found != trigger else { return }
        trigger = found
        guard let found else {
            model.action(["type": "suggest", "action": ["kind": "close"]])
            return
        }
        Self.sequence += 1
        seq = Self.sequence
        model.action(["type": "suggest", "action": [
            "kind": "query", "scope": scope.json, "list": found.kind.rawValue, "query": found.query, "seq": seq,
            "held": held,
        ]])
    }

    /// Close the list for the word being completed (tapping away, Esc).
    func close() {
        guard active, let trigger else { return }
        dismissed = trigger.start
        self.trigger = nil
        model?.action(["type": "suggest", "action": ["kind": "close"]])
    }

    /// Ask again after a failed read.
    func retry() {
        let word = trigger
        trigger = nil
        if let word { caretMoved(text: text, caret: word.end, held: held) }
    }

    /// What picking `row` does to `text`. From the + list there is no word: `caret` is where the
    /// person was writing.
    func pick(_ row: SuggestionRow, text: String, caret: Int) -> ComposerPickOutcome {
        let word = trigger
        switch row.pick {
        case "refused": return .notice(row.notice ?? "This can't be added.")
        case "arguments":
            asking = (row, word)
            if let word { dismissed = word.start; trigger = nil }
            return .arguments(row)
        case "reference":
            guard let reference = row.reference else { return .notice("This can't be added.") }
            return .edit(insert(reference, at: word, text: text, caret: caret))
        default:
            let removed = word.map { ComposerEdit(text: $0.accept("", in: text).text, caret: $0.start) }
            switch row.action {
            case "files":
                // `@` where the word was (or at the caret), with its list open.
                if let word {
                    let next = word.accept("@", in: text)
                    return .edit(ComposerEdit(text: next.text, caret: word.start + 1))
                }
                let next = Self.insertAt(text, caret: caret, insert: "@ ")
                return .edit(ComposerEdit(text: next.text, caret: next.caret - 1))
            case "goal":
                // The composer sends `/goal <objective>` as the provider's own goal.
                if let word { let next = word.accept("/goal", in: text); return .edit(ComposerEdit(text: next.text, caret: next.caret)) }
                return .edit(ComposerEdit(text: "/goal " + text, caret: 6))
            default:
                if let word { dismissed = word.start; trigger = nil }
                return .run(row.pick == "attachments" ? "attachments" : row.action ?? "", removed)
            }
        }
    }

    /// The prompt form's answer arrived: its reference replaces the word it was asked from.
    func answered(_ reference: BridgeJSON, text: String, caret: Int) -> ComposerEdit {
        let word = asking?.trigger
        asking = nil
        dismissed = nil
        return insert(reference, at: word, text: text, caret: caret)
    }

    /// The bridge's answer to the open prompt form, once it came.
    var argumentsAnswer: SuggestionArguments? {
        guard let row = asking?.row, let answer = model?.suggestions.arguments, answer.row == row.id else { return nil }
        return answer
    }
    func submitArguments(_ values: [String: String]) {
        guard let row = asking?.row else { return }
        model?.suggestions.arguments = nil
        model?.action(["type": "suggest", "action": ["kind": "arguments", "row": row.id, "values": values]])
    }
    func cancelArguments() { asking = nil; dismissed = nil }
    /// A workflow from the + or `/` list, run now; its refusal shows like any other.
    func runAutomation(_ action: String) async {
        guard let model else { return }
        let id = model.admissions.nextId()
        _ = await model.admissions.wait(id: id) { model.action(["type": "suggest", "action": ["kind": "automation", "action": action, "requestId": id]]) }
    }

    /// The message went: its references went with it.
    func sent() { trigger = nil; dismissed = nil }

    private func insert(_ reference: BridgeJSON, at word: ComposerTrigger?, text: String, caret: Int) -> ComposerEdit {
        let label = reference["label"]?.text ?? ""
        if let path = reference["file"]?["path"]?.text, let scope {
            model?.action(["type": "suggest", "action": ["kind": "remember", "scope": scope.json, "path": path]])
        }
        let length = (label as NSString).length
        if let word {
            let next = word.accept(label, in: text)
            let pick = ComposerPick(start: word.start, end: word.start + length, label: label, reference: reference)
            return ComposerEdit(text: next.text, caret: next.caret, pick: pick)
        }
        let next = Self.insertAt(text, caret: caret, insert: label + " ")
        let start = next.caret - length - 1
        let pick = ComposerPick(start: start, end: start + length, label: label, reference: reference)
        return ComposerEdit(text: next.text, caret: next.caret, pick: pick)
    }

    /// `insert` at the caret as its own word, as the web's `insertAt` does.
    static func insertAt(_ text: String, caret: Int, insert: String) -> (text: String, caret: Int) {
        let ns = text as NSString
        let at = min(caret, ns.length)
        let before = ns.substring(to: at)
        let spaced = !before.isEmpty && !(before.last?.isWhitespace ?? false) ? " " + insert : insert
        return (before + spaced + ns.substring(from: at), at + (spaced as NSString).length)
    }
}
