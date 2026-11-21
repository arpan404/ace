import Foundation

/// The review writes of one pull request page: one at a time, each sent once. What GitHub did is
/// read again afterwards (the bridge marks the page's reads out of date), never assumed here.
@MainActor @Observable final class ForgeReviewDesk {
    let client: ClientModel
    let target: ForgePullTarget
    private(set) var writing = false
    /// The last write's refusal or lost answer, in the bridge's words; nil after a success.
    private(set) var message: String?
    /// "Fix with agent": hands a comment's request to the thread on this pull request, false when
    /// nothing could take it. Nil where the page offers no hand-off.
    @ObservationIgnored var fix: ((String) async -> Bool)?

    init(client: ClientModel, target: ForgePullTarget) {
        self.client = client
        self.target = target
    }

    /// `@` and `#` in this pull request's editors.
    var completer: ForgeCompleter {
        ForgeCompleter(client: client, project: target.project, repository: target.repository, on: (kind: "pull", number: target.number))
    }

    /// Where this pull request's text draws its media and links.
    var scope: ForgeRichScope { ForgeRichScope(client: client, project: target.project, repository: target.repository) }

    /// Tick or untick one task box in this pull request's text (`on` names the comment, or the
    /// description). Refusals and lost answers show as the desk's message.
    func tick(on: [String: Any], offset: Int, checked: Bool) async {
        guard !writing else { return }
        writing = true
        defer { writing = false }
        let outcome = await client.forgeTask(project: target.project, number: target.number, repository: target.repository, on: on, offset: offset, checked: checked)
        message = outcome.ok ? nil : outcome.message
    }

    var ready: Bool { !writing && client.canOperate && client.connection == "ready" }

    @discardableResult
    func run(_ action: [String: Any]) async -> Bool {
        await send(action)?.ok ?? false
    }

    private func send(_ action: [String: Any]) async -> ForgeReviewOutcome? {
        guard !writing else { return nil }
        writing = true
        defer { writing = false }
        let outcome = await client.forgeReview(target, action)
        message = outcome.ok ? nil : outcome.message
        return outcome
    }

    /// The pull request's suggestion batch, shared with its other pages.
    var batch: ForgeSuggestionBatch { client.suggestionBatches.batch(for: target) }
    /// Suggestions GitHub refused to commit: each offers the agent instead.
    private(set) var refused: Set<Int> = []

    /// Add a suggestion to the batch or take it out; a full batch says why it can't take more.
    func toggleBatch(_ commentId: Int, _ suggestion: ForgeComment.Suggestion) {
        if let reason = batch.toggle(commentId, suggestion) { message = reason }
    }

    /// One commit applying the suggestions at the head they were shown at; GitHub refuses it
    /// once the branch moved. Committed ones leave the batch.
    func commitSuggestions(_ commentIds: [Int], at head: String, message: String) async -> Bool {
        guard let outcome = await send(["kind": "suggestions.apply", "headSha": head, "commentIds": commentIds, "message": message]) else { return false }
        if outcome.ok {
            batch.committed(commentIds)
        } else if !outcome.uncertain {
            // A lost answer may have committed it: only a clear refusal offers the agent.
            refused.formUnion(commentIds)
        }
        return outcome.ok
    }

    func clearMessage() { message = nil }
    /// A hand-off or other local step that couldn't be done, in the page's words.
    func report(_ text: String) { message = text }
}

/// A text the person writes in a sheet and sends to GitHub: a reply, an edit, a quote reply or a
/// new line comment. `send` answers whether it went through; the sheet stays open when not.
struct ForgeCompose: Identifiable {
    struct Choice {
        let label: String
        let send: (String) async -> Bool
    }
    let id = UUID()
    let title: String
    var text: String
    var placeholder = "Leave a comment"
    /// The main send, then an optional second one ("Start a review" beside "Add single comment").
    let primary: Choice
    var secondary: Choice?
    /// A line's current text, offered as a suggested change.
    var suggestion: String?
    var suggestionOff: String?
    /// Why it can't be sent, shown in place of the buttons' use.
    var off: String?
}
