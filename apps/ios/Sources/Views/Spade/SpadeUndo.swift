import SwiftUI

/// A reply that changed the bot's files (ADR 0167), as the bridge put it (`spade-rows.ts`): its
/// steps in one line, undoing the whole reply from its first such step, and each step that
/// changed files on its own.
struct SpadeChanges: Decodable, Equatable, Sendable {
    struct Undo: Decodable, Equatable, Sendable {
        /// The step the reply's undo starts from.
        let from: Int
        /// The reply's steps undo can't take back ("Sent an email").
        let stays: [String]
    }
    struct Step: Decodable, Equatable, Sendable, Identifiable {
        let from: Int
        let line: String
        let detail: String?
        var id: Int { from }
    }
    let text: String
    let undo: Undo
    let steps: [Step]
}

/// What undoing from a step would put back (`bridge/spade-undo.ts`), before anything changes.
struct SpadeUndoPreview: Decodable, Sendable {
    struct Undo: Decodable, Equatable, Sendable {
        let reviewed: String
        let sentence: String
        let changed: [String]
        let added: [String]
        let deleted: [String]
        let more: Int
        /// The files are as they were: there is nothing to put back.
        let empty: Bool
    }
    let ok: Bool
    var undo: Undo? = nil
    var title: String? = nil
    var message: String? = nil
    var problem: String? { spadeRefusal(ok, title, message) }
}

/// The bot whose files an undo puts back, and the client its machine answers through.
struct SpadeUndoTarget {
    let client: ClientModel
    let agent: String
}

/// What the person asked to undo: a reply's changes, or one change.
struct SpadeUndoAsk: Identifiable, Equatable {
    let from: Int
    /// For the title: "this reply's changes", "this change".
    let what: String
    let stays: [String]
    var id: String { "\(from)/\(what)" }
}

/// The quiet line under a reply that changed the bot's files, as web's steps line: its steps in
/// words, then Undo, which undoes the whole reply, or one change when it made several. A long
/// press offers the same. Without a bot to undo for (a group's chat) it is the line alone.
struct SpadeChangesLine: View {
    let changes: SpadeChanges
    let target: SpadeUndoTarget?
    @State private var asked: SpadeUndoAsk?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
            Text(changes.text)
                .aceFont(AceDesign.TextRole.meta)
                .foregroundStyle(AceDesign.Ink.subtle)
                .lineLimit(2)
            if target != nil {
                Menu { choices } label: {
                    Text("Undo").aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.action)
                        .frame(minHeight: AceDesign.Size.tap)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Undo these changes")
                .accessibilityIdentifier("spade.undo")
            }
            Spacer(minLength: AceTheme.Spacing.none)
        }
        .contextMenu { if target != nil { choices } }
        .sheet(item: $asked) { ask in
            if let target { SpadeUndoSheet(target: target, ask: ask) }
        }
        .accessibilityIdentifier("spade.changes")
    }

    @ViewBuilder private var choices: some View {
        Button { ask(changes.undo.from, "this reply's changes") } label: {
            Label("Undo this reply's changes", ace: .arrowUUpLeft)
        }
        .accessibilityIdentifier("spade.undo.reply")
        if !changes.steps.isEmpty {
            Menu {
                ForEach(changes.steps) { step in
                    Button([step.line, step.detail].compactMap(\.self).joined(separator: " · ")) { ask(step.from, "this change") }
                        .accessibilityIdentifier("spade.undo.step.\(step.from)")
                }
            } label: { Label("Undo one change", ace: .arrowUUpLeft) }
        }
    }

    private func ask(_ from: Int, _ what: String) {
        asked = SpadeUndoAsk(from: from, what: what, stays: changes.undo.stays)
    }
}

/// Undo's confirm, as web's undo dialog: what putting the checkpoint back would do (the files
/// that go back, go and come back) and what stays as it is, then Undo. Nothing changes until
/// the person presses it; a refusal says why, and once it went the bot has been told.
private struct SpadeUndoSheet: View {
    let target: SpadeUndoTarget
    let ask: SpadeUndoAsk
    @Environment(\.dismiss) private var dismiss
    @State private var preview: SpadeUndoPreview?
    @State private var undoing = false
    @State private var problem: String?
    @State private var done: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if let shown = preview?.undo {
                        Text(shown.sentence).aceFont(AceDesign.TextRole.message)
                    } else if let refused = preview?.problem {
                        Text(refused).aceFont(AceDesign.TextRole.message).foregroundStyle(AceTheme.StatusText.failed)
                            .accessibilityIdentifier("spade.undo.problem")
                    } else {
                        Text("Comparing its files with the checkpoint…").aceFont(AceDesign.TextRole.message)
                            .foregroundStyle(AceDesign.Ink.muted)
                    }
                }
                if let shown = preview?.undo {
                    paths("Go back to how they were", shown.changed)
                    paths("Made since, removed", shown.added)
                    paths("Removed since, back again", shown.deleted)
                    if shown.more > 0 {
                        Text("And \(shown.more) more files.").aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                    }
                }
                if !ask.stays.isEmpty {
                    Section {
                        ForEach(ask.stays, id: \.self) { Text($0).aceFont(AceDesign.TextRole.message) }
                    } header: { InsetHeader("Undo can't take these back") }
                }
                if let problem {
                    Text(problem).aceFont(AceDesign.TextRole.message).foregroundStyle(AceTheme.StatusText.failed)
                        .accessibilityIdentifier("spade.undo.refused")
                }
                if let done {
                    Text(done).aceFont(AceDesign.TextRole.message).accessibilityIdentifier("spade.undo.done")
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Undo \(ask.what)?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(done == nil ? "Cancel" : "Close") { dismiss() }.disabled(undoing)
                        .accessibilityIdentifier("spade.undo.cancel")
                }
                if done == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        if undoing { ProgressView() } else {
                            Button(preview?.undo?.empty == true ? "Nothing to undo" : "Undo", action: undo)
                                .fontWeight(AceDesign.Typeface.strong)
                                .disabled(preview?.undo == nil || preview?.undo?.empty == true)
                                .accessibilityIdentifier("spade.undo.confirm")
                        }
                    }
                }
            }
        }
        .tint(AceDesign.Ink.action)
        .interactiveDismissDisabled(undoing)
        .task { preview = await target.client.spadeUndoPreview(target.agent, seq: ask.from) }
        .accessibilityIdentifier("spade.undo.sheet")
    }

    @ViewBuilder private func paths(_ label: String, _ paths: [String]) -> some View {
        if !paths.isEmpty {
            Section {
                ForEach(paths, id: \.self) { path in
                    Text(path).aceMonospace(AceDesign.TextRole.code).lineLimit(1).truncationMode(.middle)
                }
            } header: { InsetHeader(label) }
        }
    }

    private func undo() {
        guard !undoing, let reviewed = preview?.undo?.reviewed else { return }
        undoing = true
        problem = nil
        Task {
            defer { undoing = false }
            let outcome = await target.client.spadeUndo(target.agent, seq: ask.from, reviewed: reviewed)
            if outcome.ok {
                done = outcome.message ?? "Undone."
            } else {
                problem = outcome.problem
                if outcome.reviewAgain == true {
                    preview = nil
                    preview = await target.client.spadeUndoPreview(target.agent, seq: ask.from)
                }
            }
        }
    }
}
