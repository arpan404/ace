import SwiftUI

/// What a comment row can ask its page to do: open a text to write (quote reply, edit) and send
/// a review write.
struct ForgeCommentActions {
    let desk: ForgeReviewDesk
    let compose: (ForgeCompose) -> Void
    /// Where Quote reply sends its text: the conversation's box, or the thread's reply.
    let quote: (String) -> Void
}

/// One comment wherever a pull request shows it: who and when, its text (or the reason it is
/// hidden, with Show), its reactions, and a ⋯ menu with Quote reply, Copy link, then Edit, Hide
/// or Unhide and Delete where GitHub lets this account. Delete asks first.
struct ForgeCommentView: View {
    let comment: ForgeComment
    /// Words after the author: "requested changes", or nothing for a plain comment.
    var words: String?
    var tone: String?
    let actions: ForgeCommentActions
    @State private var shown = false
    @State private var deleting = false

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            header
            if let hidden = comment.hidden {
                HStack(spacing: AceTheme.Spacing.xs) {
                    Text(hidden).meta(AceTheme.Colours.subtleForeground)
                    Button(shown ? "Hide" : "Show") { shown.toggle() }
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .accessibilityIdentifier("forge.comment.show.\(comment.id)")
                }
            }
            if comment.hidden == nil || shown {
                if !comment.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    MarkdownView(text: comment.body)
                }
                ForgeReactionsRow(comment: comment, desk: actions.desk)
            }
        }
        .accessibilityIdentifier("forge.comment.\(comment.id)")
        .confirmationDialog("Delete this comment?", isPresented: $deleting, titleVisibility: .visible) {
            Button("Delete comment", role: .destructive) {
                Task { await actions.desk.run(["kind": "comment.delete", "source": comment.source, "commentId": comment.commentId]) }
            }
        } message: { Text("It's removed from GitHub for everyone.") }
    }

    private var header: some View {
        HStack(spacing: AceTheme.Spacing.xs) {
            Text(comment.author).fontWeight(.medium).foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
            if let words {
                Text(words).foregroundStyle(tone.map { AceTone($0).text } ?? AceTheme.Colours.mutedForeground).lineLimit(1)
            }
            if let at = comment.at {
                Text(verbatim: "·").foregroundStyle(AceTheme.Colours.subtleForeground)
                ForgeAge(at: at)
            }
            Spacer(minLength: AceTheme.Spacing.sm)
            menu
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
        .foregroundStyle(AceTheme.Colours.mutedForeground)
    }

    private var menu: some View {
        Menu {
            if comment.quote {
                Button("Quote reply", ace: .arrowBendUpLeft) { actions.quote(comment.quoteText) }
            }
            if let link = URL(string: comment.url) {
                Button("Copy link", ace: .linkSimple) { UIPasteboard.general.url = link }
            }
            if comment.edit || comment.hide || comment.unhide || comment.remove {
                Divider()
            }
            if comment.edit {
                Button("Edit", ace: .pencilSimple) { edit() }
            }
            if comment.hide {
                Menu {
                    ForEach(Self.hideReasons, id: \.value) { reason in
                        Button(reason.label) { run(["kind": "comment.hide", "reason": reason.value]) }
                    }
                } label: { Label("Hide", ace: .eyeSlash) }
            }
            if comment.unhide {
                Button("Unhide", ace: .eye) { run(["kind": "comment.unhide"]) }
            }
            if comment.remove {
                Button("Delete", ace: .trash, role: .destructive) { deleting = true }
            }
        } label: {
            Image(ace: .dotsThree).frame(width: 32, height: 28).contentShape(Rectangle())
        }
        .disabled(!actions.desk.ready)
        .accessibilityLabel("Actions for \(comment.author)'s comment")
        .accessibilityIdentifier("forge.comment.menu.\(comment.id)")
    }

    /// GitHub's reasons for hiding a comment, in its words.
    private static let hideReasons: [(value: String, label: String)] = [
        ("off-topic", "Off-topic"), ("outdated", "Outdated"), ("resolved", "Resolved"),
        ("duplicate", "Duplicate"), ("spam", "Spam"),
    ]

    private func run(_ fields: [String: Any]) {
        var action = fields
        action["source"] = comment.source
        action["commentId"] = comment.commentId
        Task { await actions.desk.run(action) }
    }

    private func edit() {
        let comment = comment
        let desk = actions.desk
        actions.compose(ForgeCompose(
            title: "Edit comment", text: comment.editBody,
            primary: .init(label: "Update comment") { body in
                await desk.run(["kind": "comment.edit", "source": comment.source, "commentId": comment.commentId, "body": body])
            }))
    }
}

/// A comment's reactions: each one given, with its count (the viewer's own in full ink), and a
/// picker for all eight. Pressing one of the viewer's own takes it back.
struct ForgeReactionsRow: View {
    let comment: ForgeComment
    let desk: ForgeReviewDesk

    var body: some View {
        if !comment.reactions.isEmpty {
            HStack(spacing: AceTheme.Spacing.xs) {
                ForEach(comment.reactions.filter { $0.count > 0 }, id: \.content) { reaction in
                    Button { toggle(reaction) } label: {
                        HStack(spacing: AceTheme.Spacing.xxs) {
                            AceIcon(Self.icon(reaction.content), size: 14, relativeTo: .footnote)
                            Text(verbatim: "\(reaction.count)").monospacedDigit()
                        }
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .fontWeight(reaction.viewer ? .semibold : .regular)
                        .foregroundStyle(reaction.viewer ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
                        .padding(.horizontal, AceTheme.Spacing.sm)
                        .frame(minHeight: 28)
                        .background(reaction.viewer ? AceTheme.Colours.fill : .clear, in: AceShape.capsule)
                        .overlay(AceShape.capsule.stroke(AceTheme.Colours.separator, lineWidth: AceTheme.Dimensions.border))
                    }
                    .buttonStyle(.plain)
                    .disabled(!desk.ready)
                    .accessibilityLabel("\(reaction.label), \(reaction.count)\(reaction.viewer ? ", yours" : "")")
                }
                Menu {
                    ForEach(comment.reactions, id: \.content) { reaction in
                        Toggle(isOn: Binding(get: { reaction.viewer }, set: { _ in toggle(reaction) })) {
                            Label(reaction.label, ace: Self.icon(reaction.content))
                        }
                    }
                } label: {
                    AceIcon(.smileySticker, size: 16, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.subtleForeground)
                        .frame(width: 32, height: 28).contentShape(Rectangle())
                }
                .disabled(!desk.ready)
                .accessibilityLabel("Add reaction")
                .accessibilityIdentifier("forge.react.\(comment.id)")
            }
        }
    }

    private func toggle(_ reaction: ForgeComment.Reaction) {
        let subject: [String: Any] = ["kind": comment.source, "commentId": comment.commentId]
        Task { await desk.run(["kind": reaction.viewer ? "reaction.remove" : "reaction.add", "subject": subject, "content": reaction.content]) }
    }

    /// The web's reaction glyphs (Phosphor), by GitHub's reaction name.
    static func icon(_ content: String) -> AceIcon.Name {
        switch content {
        case "+1": .thumbsUp
        case "-1": .thumbsDown
        case "laugh": .smiley
        case "hooray": .confetti
        case "confused": .smileyMeh
        case "heart": .heart
        case "rocket": .rocketLaunch
        default: .eyes
        }
    }
}

/// How long ago, kept current each minute.
struct ForgeAge: View {
    let at: Double
    var body: some View {
        TimelineView(.everyMinute) { context in
            Text(ActivityTime.age(since: Date(timeIntervalSince1970: at / 1000), now: context.date)).monospacedDigit()
        }
    }
}
