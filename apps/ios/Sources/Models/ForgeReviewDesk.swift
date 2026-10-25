import Foundation

/// The review writes of one pull request page: one at a time, each sent once. What GitHub did is
/// read again afterwards (the bridge marks the page's reads out of date), never assumed here.
@MainActor @Observable final class ForgeReviewDesk {
    let client: ClientModel
    let target: ForgePullTarget
    private(set) var writing = false
    /// The last write's refusal or lost answer, in the bridge's words; nil after a success.
    private(set) var message: String?

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
        guard !writing else { return false }
        writing = true
        defer { writing = false }
        let outcome = await client.forgeReview(target, action)
        message = outcome.ok ? nil : outcome.message
        return outcome.ok
    }

    func clearMessage() { message = nil }
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
    /// Why it can't be sent, shown in place of the buttons' use.
    var off: String?
}
