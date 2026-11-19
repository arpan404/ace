import SwiftUI

/// What a request offers from outside its thread, for an inbox row and for the needs-you run.
/// Approvals answer with the options the request itself offered (the shared verbs, in the
/// thread strip's words); nothing is invented. Anything else is answered in its thread. While an
/// answer travels, the words say so instead.
@MainActor struct NeedActions {
    struct Word: Identifiable {
        let id: String
        let label: String
        var primary = false
        let run: () -> Void
    }
    let request: ApprovalRow
    let model: ClientModel
    let threadId: String
    /// A decision was sent: the haptic's trigger.
    let decided: () -> Void

    /// What is happening to an answer on its way: saved on the phone, then with the machine
    /// until it closes the request.
    var progress: String? { Self.progress(model.approvalSubmissions[request.id]) }
    static func progress(_ submission: ApprovalSubmission?) -> String? {
        switch submission?.phase {
        case .saving?: "Sending…"
        case .waiting?: "Sent"
        case nil: nil
        }
    }
    /// Deny, then Allow once, as offered.
    var deny: Word? { verb("deny") }
    var allow: Word? { verb("allow_once") }
    /// A standing grant, only where the request offers one, named with what it covers
    /// ("Always allow in this project").
    var always: Word? { verb("always_allow") }

    /// What an inbox row answers without opening its thread, for its swipes, long-press menu and
    /// VoiceOver actions: Allow once, then Deny, as offered. Only an approval whose answer isn't
    /// already on its way, shown whole, on a phone that may act; a question, a plan or a form
    /// needs more than yes or no and is answered in its thread.
    var answers: [Word] {
        guard request.kind == "approval", !request.tooLargeToApprove, model.canOperate,
              model.approvalSubmissions[request.id] == nil else { return [] }
        return [allow, deny].compactMap { $0 }
    }

    private func verb(_ name: String) -> Word? {
        if let verb = request.verbs.first(where: { $0.decision.verb == name }) {
            // A standing grant says what it covers ("Always allow here"); the others are the verb.
            let words = name == "always_allow" ? (verb.decision.name ?? verb.decision.label) : verb.decision.label
            return Word(id: name, label: words, primary: name == "allow_once") { send(verb.option) }
        }
        // A daemon that sends no verbs: its own Deny and Allow once options, as offered.
        guard (request.decisions ?? []).isEmpty else { return nil }
        let kind = name == "deny" ? "deny" : name == "allow_once" ? "allow_once" : nil
        guard let kind, let option = request.options.first(where: { $0.kind == kind }) else { return nil }
        return Word(id: name, label: option.label, primary: kind == "allow_once") { send(option) }
    }
    private func send(_ option: ApprovalRow.Option) {
        model.approveNeed(request, in: threadId, option: option)
        decided()
    }
}

/// The words a request is shown with outside its thread.
enum NeedWords {
    /// One line for the row: a question's prompt, a plan's or form's sentence.
    static func subject(_ request: ApprovalRow) -> String {
        switch request.kind {
        case "question": request.questions?.first?.text ?? request.strip?.detail ?? request.title
        default: request.strip?.sentence ?? request.heading ?? request.title
        }
    }
    /// The run's sentence: who asks for what ("Codex wants to run a command").
    static func sentence(_ request: ApprovalRow) -> String {
        request.strip?.sentence ?? request.heading ?? request.title
    }
    /// Where the shown request stands among what waits, in one plain phrase: "1 of 3" on this
    /// thread; "1 of 2 here, 3 more in delegated work" or "3 more in delegated work" when some
    /// wait in its delegated threads, which this row can't show; "1 of 200 read, more waiting"
    /// when the phone's read stopped before finding them all. Nil for one alone.
    static func position(_ tally: NeedTally) -> String? {
        if tally.more { return "1 of \(tally.here) read, more waiting" }
        let delegated = tally.elsewhere > 0 ? "\(tally.elsewhere) more in delegated work" : nil
        guard tally.here > 1 else { return delegated }
        return delegated.map { "1 of \(tally.here) here, \($0)" } ?? "1 of \(tally.here)"
    }
    /// The same, as VoiceOver reads it.
    static func spokenPosition(_ tally: NeedTally) -> String? {
        if tally.more { return "1 of \(tally.here) requests read on this phone, more waiting" }
        let delegated = tally.elsewhere > 0 ? "\(tally.elsewhere) more \(tally.elsewhere == 1 ? "request" : "requests") in delegated work" : nil
        guard tally.here > 1 else { return delegated }
        return delegated.map { "1 of \(tally.here) requests here, \($0)" } ?? "1 of \(tally.here) requests"
    }
    /// "3 need you" for the top of the list; nil while nothing does.
    static func count(_ total: Int) -> String? {
        total <= 0 ? nil : total == 1 ? "1 needs you" : "\(total) need you"
    }
}
