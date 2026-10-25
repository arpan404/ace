import SwiftUI

/// A line conversation: where it sits (in the Timeline), then its comments, then Reply and
/// Resolve. A resolved conversation folds to one line until shown. On a conversation locked to
/// this account Reply stays, turned off, with the reason.
struct ForgeThreadBlock: View {
    let thread: ForgeLineThread
    /// Off in the Code view, where the line itself says where it is.
    var showsPlace = true
    let desk: ForgeReviewDesk
    let compose: (ForgeCompose) -> Void
    @State private var open = false

    private var folded: Bool { thread.resolved && !open }

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            heading
            if !folded {
                ForEach(thread.comments) { comment in
                    ForgeCommentView(comment: comment, actions: ForgeCommentActions(desk: desk, compose: compose, quote: reply))
                }
                footer
            }
        }
        .padding(.leading, AceTheme.Spacing.md)
        .overlay(alignment: .leading) {
            Rectangle().fill(AceTheme.Colours.separator).frame(width: AceTheme.Dimensions.border)
        }
        .accessibilityIdentifier("forge.thread.\(thread.id)")
    }

    @ViewBuilder private var heading: some View {
        let state = [thread.resolved ? "Resolved" : nil, thread.outdated ? "Outdated" : nil].compactMap { $0 }
        if showsPlace || !state.isEmpty {
            HStack(spacing: AceTheme.Spacing.xs) {
                if showsPlace {
                    Text(thread.place).aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.subtleForeground).lineLimit(1).truncationMode(.head)
                }
                if !state.isEmpty { Text(state.joined(separator: " · ")).meta() }
                Spacer(minLength: AceTheme.Spacing.sm)
                if thread.resolved {
                    Button(open ? "Hide" : "Show") { open.toggle() }
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                }
            }
        }
    }

    @ViewBuilder private var footer: some View {
        if thread.canReply || thread.canResolve {
            HStack(spacing: AceTheme.Spacing.lg) {
                if thread.canReply {
                    Button("Reply") { reply("") }
                        .disabled(thread.replyOff != nil || !desk.ready)
                        .accessibilityIdentifier("forge.thread.reply.\(thread.id)")
                }
                if thread.canResolve {
                    Button(thread.resolved ? "Unresolve conversation" : "Resolve conversation") {
                        Task { await desk.run(["kind": thread.resolved ? "thread.unresolve" : "thread.resolve", "threadId": thread.id]) }
                    }
                    .disabled(!desk.ready)
                    .accessibilityIdentifier("forge.thread.resolve.\(thread.id)")
                }
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            if let off = thread.replyOff { Text(off).meta() }
        }
    }

    /// Reply to the conversation's first comment, opening with `text` (a quote, or nothing).
    private func reply(_ text: String) {
        guard let root = thread.comments.first else { return }
        let desk = desk
        compose(ForgeCompose(
            title: "Reply", text: text, placeholder: "Reply",
            primary: .init(label: "Reply") { body in await desk.run(["kind": "reply", "commentId": root.commentId, "body": body]) },
            off: thread.replyOff))
    }
}
