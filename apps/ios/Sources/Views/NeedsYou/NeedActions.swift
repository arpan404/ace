import SwiftUI

/// What a request offers from outside its thread, for a row and for the needs-you run alike.
/// Approvals answer with the options the request itself offered (the shared verbs, in the
/// thread strip's words); nothing is invented. A question opens its answer, a plan its review,
/// browser help its thread. While an answer travels, the words say so instead.
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
    let open: () -> Void
    let review: () -> Void
    /// A decision was sent: the haptic's trigger.
    let decided: () -> Void

    /// What is happening to an answer on its way: saved on the phone, then with the machine
    /// until it closes the request.
    var progress: String? {
        switch model.approvalSubmissions[request.id]?.phase {
        case .saving?: "Sending…"
        case .waiting?: "Sent"
        case nil: nil
        }
    }
    /// Deny, then Allow once, as offered.
    var deny: Word? { verb("deny") }
    var allow: Word? { verb("allow_once") }
    /// A standing grant, only where the request offers one ("Always allow"); what it covers is
    /// `scope`.
    var always: Word? { verb("always_allow") }
    /// What a standing grant covers, in the provider's words, where it says more than the verb.
    var scope: String { request.verbs.first { $0.decision.verb == "always_allow" }?.decision.scope ?? "" }

    /// The row's words, at most two.
    var row: [Word] {
        switch request.kind {
        case "approval": [deny, allow].compactMap { $0 }
        case "question": [request.unanswerable == true ? Word(id: "open", label: "Open", primary: true, run: open)
                                                        : Word(id: "answer", label: "Answer", primary: true, run: review)]
        case "browser_help": [Word(id: "open", label: "Open", primary: true, run: open)]
        default: [Word(id: "review", label: "Review", primary: true, run: review)]
        }
    }

    private func verb(_ name: String) -> Word? {
        if let verb = request.verbs.first(where: { $0.decision.verb == name }) {
            return Word(id: name, label: verb.decision.label, primary: name == "allow_once") { send(verb.option) }
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
    /// "3 need you" for the top of the list; nil while nothing does.
    static func count(_ total: Int) -> String? {
        total <= 0 ? nil : total == 1 ? "1 needs you" : "\(total) need you"
    }
}
