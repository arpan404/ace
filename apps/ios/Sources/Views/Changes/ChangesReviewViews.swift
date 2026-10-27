import SwiftUI

extension ClientModel {
    /// A review action for the Changes sheet (`bridge/CHANGES-CONTRACT.md`); answers the request
    /// id its `changes.notice` will carry, or nil when it couldn't be sent.
    @discardableResult func reviewAction(_ kind: String, _ fields: [String: Any] = [:]) -> String? {
        let id = "review-\(UUID().uuidString.prefix(18))"
        var action = fields
        action["kind"] = kind
        action["requestId"] = id
        return sheet(action) ? id : nil
    }
}

/// A comment under the lines it's on: its state in a word, the text, a suggested change in mono,
/// and what can be done next as words: Send, Edit, Delete for a draft; Reply, Resolve, Apply
/// suggestion once sent; Reopen once resolved.
struct ReviewCommentCard: View {
    @Bindable var model: ClientModel
    let draft: ChangesReview.Draft
    let edit: (ChangesReview.Draft) -> Void
    let replies: (ChangesReview.Draft) -> Void
    @State private var confirmDelete = false

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            HStack(spacing: AceTheme.Spacing.sm) {
                Text(stateWord).fontWeight(.medium).foregroundStyle(stateColour)
                Text(draft.lines).foregroundStyle(AceTheme.Colours.subtleForeground)
                if draft.anchor == "outdated" { Text("Outdated").foregroundStyle(AceTheme.Colours.subtleForeground) }
                if draft.anchor == "addressed-pending-review" { Text("Changed since").foregroundStyle(AceTheme.Colours.subtleForeground) }
                Spacer(minLength: 0)
                if draft.state == "sending" || draft.state == "resolving" { ProgressView().controlSize(.mini) }
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
            Text(draft.text).aceFont(AceTheme.Typography.body, relativeTo: .body)
                .foregroundStyle(draft.state == "resolved" ? AceTheme.Colours.mutedForeground : AceTheme.Colours.foreground)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            if let suggestion = draft.suggestion {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    Text(draft.applied ? "Suggested change · applied" : "Suggested change")
                        .aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground)
                    Text(suggestion.isEmpty ? "Delete these lines" : suggestion)
                        .aceMonospace(FileDiffStyle.line, relativeTo: .caption)
                        .foregroundStyle(AceTheme.Colours.foreground)
                        .padding(AceTheme.Spacing.sm)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(AceTheme.Colours.diffAdd, in: RoundedRectangle(cornerRadius: AceTheme.Radii.sm))
                }
            }
            if let error = draft.error {
                Text(error).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.StatusText.failed)
            }
            actions
        }
        .padding(.vertical, AceTheme.Spacing.md)
        .padding(.leading, FileDiffStyle.gutter)
        .padding(.trailing, AceTheme.Spacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .leading) {
            Rectangle().fill(AceTheme.Colours.separator).frame(width: 2).padding(.leading, FileDiffStyle.gutter - AceTheme.Spacing.md)
        }
        .transition(.opacity)
        .confirmationDialog("Delete this comment?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete comment", role: .destructive) { model.sheet(["kind": "review.discard", "key": draft.key]) }
            Button("Cancel", role: .cancel) {}
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("review.comment")
    }

    @ViewBuilder private var actions: some View {
        HStack(spacing: AceTheme.Spacing.lg) {
            switch draft.state {
            case "draft", "failed":
                word(draft.state == "failed" ? "Retry" : "Send") { send() }
                word("Edit") { edit(draft) }
                if draft.suggestion != nil { word("Apply suggestion") { _ = model.reviewAction("review.apply", ["key": draft.key]) } }
                word("Delete", tone: AceTheme.StatusText.failed) { confirmDelete = true }
            case "sent":
                word("Reply") { replies(draft) }
                word("Resolve") { _ = model.reviewAction("review.resolve", ["key": draft.key, "resolved": true]); UISelectionFeedbackGenerator().selectionChanged() }
                if draft.suggestion != nil, !draft.applied { word("Apply suggestion") { _ = model.reviewAction("review.apply", ["key": draft.key]) } }
            case "resolved":
                if draft.sent { word("Replies") { replies(draft) } }
                word("Reopen") { _ = model.reviewAction("review.resolve", ["key": draft.key, "resolved": false]) }
                word("Delete", tone: AceTheme.StatusText.failed) { confirmDelete = true }
            default: EmptyView()
            }
        }
        .disabled(!model.canOperate || draft.state == "sending" || draft.state == "resolving")
    }

    private func word(_ title: String, tone: Color = AceTheme.Colours.foreground, _ action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .buttonStyle(.plain)
            .aceFont(AceTheme.Typography.label, relativeTo: .footnote)
            .foregroundStyle(tone)
            .frame(minHeight: 44)
            .accessibilityIdentifier("review.\(title.lowercased())")
    }
    private func send() {
        model.reviewAction("review.send", ["keys": [draft.key]])
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
    private var stateWord: String {
        switch draft.state {
        case "draft": "Draft"
        case "sending": "Sending"
        case "sent": "Sent"
        case "failed": "Not sent"
        case "resolving": "Resolving"
        default: "Resolved"
        }
    }
    private var stateColour: Color {
        draft.state == "failed" ? AceTheme.StatusText.failed : draft.state == "resolved" ? AceTheme.Colours.mutedForeground : AceTheme.Colours.foreground
    }
}

/// Write or edit a comment on picked lines, with an optional suggested change that starts as the
/// lines' current text.
struct ReviewComposer: View {
    @Bindable var model: ClientModel
    let path: String
    let side: String
    let start: Int
    let end: Int
    /// The lines as they read now, to start a suggestion from.
    let current: String
    var editing: ChangesReview.Draft?
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var suggesting = false
    @State private var suggestion = ""
    @State private var request: String?
    @FocusState private var focused: Bool

    private var notice: ChangesNotice? { request.flatMap { model.sheets.notices[$0] } }
    private var saving: Bool { request != nil && notice == nil }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Comment", text: $text, axis: .vertical)
                        .lineLimit(3...12).focused($focused)
                        .accessibilityIdentifier("review.text")
                } header: { Text("\((path as NSString).lastPathComponent) · \(start == end ? "line \(start)" : "lines \(start)–\(end)")") }
                if side == "new" {
                    Section {
                        Toggle("Suggest a change", isOn: $suggesting.animation(.smooth))
                            .accessibilityIdentifier("review.suggest")
                        if suggesting {
                            TextField("Replacement", text: $suggestion, axis: .vertical)
                                .font(.system(.footnote, design: .monospaced))
                                .lineLimit(2...16)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                        }
                    } footer: {
                        if suggesting { Text("Apply suggestion writes this over the lines in the checkout.") }
                    }
                }
                if let notice, !notice.ok {
                    Text(notice.message).foregroundStyle(AceTheme.StatusText.failed)
                }
            }
            .navigationTitle(editing == nil ? "Comment" : "Edit comment").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if saving { ProgressView() } else {
                        Button("Save") { save() }.fontWeight(.semibold)
                            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityIdentifier("review.save")
                    }
                }
            }
            .onAppear {
                text = editing?.text ?? ""
                suggestion = editing?.suggestion ?? current
                suggesting = editing?.suggestion != nil
                focused = true
            }
            .onChange(of: notice) { _, notice in
                if notice?.ok == true { UINotificationFeedbackGenerator().notificationOccurred(.success); dismiss() }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func save() {
        var fields: [String: Any] = ["path": path, "side": side, "start": start, "end": end, "text": String(text.prefix(4096))]
        if suggesting { fields["suggestion"] = String(suggestion.prefix(8192)) }
        if let editing { fields["key"] = editing.key }
        request = model.reviewAction("review.draft", fields)
    }
}

/// A sent comment's replies, oldest first, and a field to add one.
struct ReviewRepliesSheet: View {
    @Bindable var model: ClientModel
    let draft: ChangesReview.Draft
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var request: String?
    private var replies: ChangesReplies? { model.sheets.replies?.key == draft.key ? model.sheets.replies : nil }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(draft.text).foregroundStyle(AceTheme.Colours.mutedForeground)
                }
                if let replies {
                    if replies.state == "loading" { ProgressView().frame(maxWidth: .infinity) }
                    if replies.state == "error" { Text(replies.message).foregroundStyle(AceTheme.StatusText.failed) }
                    ForEach(replies.replies) { reply in Text(reply.text).textSelection(.enabled) }
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }
            .listStyle(.plain)
            .safeAreaInset(edge: .bottom) {
                HStack(spacing: AceTheme.Spacing.sm) {
                    TextField("Reply", text: $text, axis: .vertical).lineLimit(1...5)
                        .padding(.horizontal, AceTheme.Spacing.md).padding(.vertical, AceTheme.Spacing.sm)
                        .background(AceTheme.Colours.fill, in: RoundedRectangle(cornerRadius: AceTheme.Radii.lg))
                    Button("Reply") {
                        request = model.reviewAction("review.reply", ["key": draft.key, "text": String(text.prefix(4096))])
                        text = ""
                    }
                    .fontWeight(.semibold)
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.canOperate)
                    .frame(minHeight: 44)
                }
                .padding(AceTheme.Spacing.lg)
                .background(.bar)
            }
            .navigationTitle("Replies").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .onAppear { model.sheet(["kind": "review.replies", "key": draft.key]) }
        }
        .presentationDetents([.medium, .large])
    }
}

/// The bar at the sheet's foot: the picked lines with Comment, or the review's state with its
/// comments, Send, Approve and Request changes.
struct ReviewBar: View {
    @Bindable var model: ClientModel
    @Binding var selection: LineSelection?
    let comment: () -> Void
    let list: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var review: ChangesReview? { model.sheets.review }

    var body: some View {
        Group {
            if let selection {
                HStack(spacing: AceTheme.Spacing.md) {
                    Text(selection.label).fontWeight(.medium).monospacedDigit()
                    Text(selection.side == "old" ? "removed side" : "").foregroundStyle(AceTheme.Colours.mutedForeground)
                    Spacer(minLength: AceTheme.Spacing.sm)
                    Button("Clear") { self.selection = nil }.foregroundStyle(AceTheme.Colours.mutedForeground)
                        .accessibilityIdentifier("review.clear")
                    Button("Comment", action: comment).fontWeight(.semibold)
                        .disabled(!model.canOperate)
                        .accessibilityIdentifier("review.compose")
                }
            } else if let review, !review.drafts.isEmpty || review.session != nil {
                HStack(spacing: AceTheme.Spacing.md) {
                    Button(action: list) {
                        Text(summary(review)).fontWeight(.medium).lineLimit(1)
                            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .accessibilityIdentifier("review.list")
                    if review.pending > 0 {
                        Button("Send \(review.pending)") {
                            model.reviewAction("review.send")
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        }
                        .fontWeight(.semibold).disabled(!model.canOperate)
                        .accessibilityIdentifier("review.sendAll")
                    }
                }
            }
        }
        .buttonStyle(.plain)
        .foregroundStyle(AceTheme.Colours.foreground)
        .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
        .padding(.horizontal, AceTheme.Spacing.xl)
        .frame(minHeight: 48)
        .aceGlass(in: AceShape.capsule)
        .padding(.horizontal, AceTheme.Spacing.lg)
        .padding(.bottom, AceTheme.Spacing.sm)
        .opacity(selection == nil && (review?.drafts.isEmpty ?? true) && review?.session == nil ? 0 : 1)
        .animation(reduceMotion ? .easeInOut(duration: AceTheme.Motion.fast) : .smooth(duration: AceTheme.Motion.standard), value: selection)
    }

    private func summary(_ review: ChangesReview) -> String {
        var parts: [String] = []
        if let status = review.session?.status, status != "open" { parts.append(status == "approved" ? "Approved" : "Changes requested") }
        let count = review.drafts.count
        parts.append(count == 0 ? "Review" : "\(count) \(count == 1 ? "comment" : "comments")")
        return parts.joined(separator: " · ")
    }
}

/// Every comment of this thread's review, by file, with Approve and Request changes.
struct ReviewCommentsSheet: View {
    @Bindable var model: ClientModel
    let reveal: (ChangesReview.Draft) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var editing: ChangesReview.Draft?
    @State private var replying: ChangesReview.Draft?
    private var review: ChangesReview? { model.sheets.review }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    if let message = review?.message, !message.isEmpty {
                        Text(message).foregroundStyle(AceTheme.StatusText.failed).padding(AceTheme.Spacing.lg)
                    }
                    if review?.drafts.isEmpty ?? true {
                        EmptyState(icon: .chatText, title: "No comments", line: "Tap a line in a diff to comment on it.") { EmptyView() }
                            .padding(.top, AceTheme.Spacing.xxxl)
                    }
                    ForEach(groups, id: \.0) { path, drafts in
                        Button { if let first = drafts.first { reveal(first); dismiss() } } label: {
                            Text(path).aceMonospace(FileDiffStyle.path, relativeTo: .footnote)
                                .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1).truncationMode(.head)
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        }
                        .buttonStyle(.plain)
                        .padding(.horizontal, AceTheme.Spacing.lg)
                        ForEach(drafts) { draft in
                            ReviewCommentCard(model: model, draft: draft, edit: { editing = $0 }, replies: { replying = $0 })
                        }
                    }
                }
            }
            .background(AceTheme.Colours.background)
            .refreshable { model.sheet(["kind": "review.refresh"]) }
            .safeAreaInset(edge: .bottom) {
                HStack(spacing: AceTheme.Spacing.md) {
                    Button("Request changes") { model.reviewAction("review.status", ["status": "changes-requested"]) }
                        .buttonStyle(.bordered).buttonBorderShape(.capsule)
                        .accessibilityIdentifier("review.requestChanges")
                    Button("Approve") {
                        model.reviewAction("review.status", ["status": "approved"])
                        UINotificationFeedbackGenerator().notificationOccurred(.success)
                    }
                    .buttonStyle(.borderedProminent).buttonBorderShape(.capsule)
                    .accessibilityIdentifier("review.approve")
                }
                .tint(AceTheme.Colours.foreground)
                .disabled(!model.canOperate)
                .padding(AceTheme.Spacing.lg)
                .frame(maxWidth: .infinity)
            }
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                if (review?.pending ?? 0) > 0 {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Send \(review?.pending ?? 0)") { model.reviewAction("review.send") }.disabled(!model.canOperate)
                    }
                }
            }
            .onAppear { model.sheet(["kind": "review.refresh"]) }
            .sheet(item: $replying) { draft in ReviewRepliesSheet(model: model, draft: draft) }
            .sheet(item: $editing) { draft in
                ReviewComposer(model: model, path: draft.path, side: draft.side, start: draft.start, end: draft.end,
                               current: draft.suggestion ?? "", editing: draft)
            }
        }
    }

    private var title: String {
        switch review?.session?.status {
        case "approved": "Review · Approved"
        case "changes-requested": "Review · Changes requested"
        default: "Review"
        }
    }
    private var groups: [(String, [ChangesReview.Draft])] {
        var order: [String] = []
        var byPath: [String: [ChangesReview.Draft]] = [:]
        for draft in review?.drafts ?? [] {
            if byPath[draft.path] == nil { order.append(draft.path) }
            byPath[draft.path, default: []].append(draft)
        }
        return order.map { ($0, byPath[$0] ?? []) }
    }
}
