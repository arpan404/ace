import SwiftUI

/// The thread's own lists and dialogs opened from its header, ⋯ menu and messages.
enum ThreadSheet: String, Identifiable {
    case merge, turns, files
    var id: String { rawValue }
}

extension View {
    /// Rename, Bring back to parent, Turns, Attachments and Rewind's confirmation for the open
    /// thread, and what its messages' actions do (`messageTransitions`).
    func threadTransitions(model: ClientModel, thread: ThreadModel, title: String, renaming: Binding<Bool>,
                           sheet: Binding<ThreadSheet?>, openThread: @escaping (String) -> Void) -> some View {
        modifier(ThreadTransitionsHost(model: model, thread: thread, title: title, renaming: renaming, sheet: sheet,
                                       openThread: openThread))
    }
}

private struct ThreadTransitionsHost: ViewModifier {
    let model: ClientModel
    let thread: ThreadModel
    let title: String
    @Binding var renaming: Bool
    @Binding var sheet: ThreadSheet?
    let openThread: (String) -> Void
    @State private var rewinding: TranscriptRow?
    @State private var retried = 0
    @State private var problem: String?

    func body(content: Content) -> some View {
        content
            .environment(\.messageTransitions, model.canOperate ? transitions : nil)
            .sensoryFeedback(.success, trigger: retried)
            .renameThread(model: model, threadId: thread.id, title: title, isPresented: $renaming)
            .sheet(item: $sheet) { which in
                switch which {
                case .merge:
                    MergeSheet(model: model, screen: thread.screen) { parent in openThread(parent) }
                case .turns:
                    TurnsSheet(model: model, threadId: thread.id) { ordinal in
                        model.focusOnOpen = ThreadFocus(thread: thread.id, item: "", turn: ordinal)
                    }
                case .files:
                    ThreadFilesSheet(model: model, threadId: thread.id)
                }
            }
            .alert("Rewind to here?", isPresented: Binding(get: { rewinding != nil }, set: { if !$0 { rewinding = nil } })) {
                Button("Cancel", role: .cancel) {}
                Button("Rewind") {
                    guard let row = rewinding else { return }
                    Task { if await model.rewind(to: row.id) { retried += 1 } }
                }.accessibilityIdentifier("rewind.confirm")
            } message: {
                Text("Your next message continues from this turn. Later turns stay visible in ace, but Pi won't use them as context. Files are not reverted.")
            }
    }

    private var transitions: MessageTransitions {
        MessageTransitions(
            row: thread.screen.transitions,
            fork: { row in Task { _ = await model.openFork(.answer(itemId: row.id, runId: row.runId)) } },
            edit: { row in Task { _ = await model.openFork(.edit(itemId: row.id)) } },
            retry: { row in Task { if await model.retryAnswer(row.id) { retried += 1 } } },
            rewind: { row in rewinding = row })
    }
}

extension View {
    /// The system's rename alert: the name, Save, and Name it again from the opening request.
    func renameThread(model: ClientModel, threadId: String, title: String, isPresented: Binding<Bool>) -> some View {
        modifier(RenameThread(model: model, threadId: threadId, title: title, isPresented: isPresented))
    }
}

private struct RenameThread: ViewModifier {
    let model: ClientModel?
    let threadId: String
    let title: String
    @Binding var isPresented: Bool
    @State private var saved = 0
    private static let offline = "This machine isn't connected."
    func body(content: Content) -> some View {
        content
            .sensoryFeedback(.success, trigger: saved)
            .sheet(isPresented: $isPresented) {
                RenameSheet(title: title,
                            save: { typed in
                                guard let model else { return Self.offline }
                                return await model.rename(threadId, to: typed)
                            },
                            retitle: {
                                guard let model else { return Self.offline }
                                return await model.retitle(threadId)
                            },
                            done: { saved += 1 })
            }
    }
}

/// The thread's name, selected so typing replaces it, with Save and a quiet "Name from first
/// message" under it. Return saves. A refusal stays on the sheet in words.
private struct RenameSheet: View {
    let title: String
    let save: (String) async -> String?
    let retitle: () async -> String?
    let done: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var selection: TextSelection?
    @State private var problem: String?
    @State private var sending = false
    @FocusState private var focused: Bool
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.md) {
                TextField("Name", text: $name, selection: $selection)
                    .aceFont(AceTheme.Typography.body, relativeTo: .body)
                    .padding(.horizontal, AceTheme.Spacing.md)
                    .frame(minHeight: AceTheme.Dimensions.touchTarget)
                    .background(AceTheme.Colours.fill, in: AceShape.field)
                    .focused($focused)
                    .submitLabel(.done)
                    .onSubmit { run { await save(name) } }
                    .disabled(sending)
                    .accessibilityIdentifier("rename.field")
                if let problem {
                    Text(problem).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.StatusText.failed)
                        .transition(.opacity)
                }
                Button("Name from first message") { run(retitle) }
                    .buttonStyle(StripTextButtonStyle())
                    .disabled(sending)
                    .accessibilityIdentifier("rename.retitle")
                Spacer(minLength: AceTheme.Spacing.none)
            }
            .padding(.horizontal, AceTheme.Spacing.xl).padding(.top, AceTheme.Spacing.sm)
            .animation(.smooth, value: problem)
            .background(AceTheme.Colours.background)
            .navigationTitle("Rename thread")
            .navigationBarTitleDisplayMode(.inline)
            .escapeCloses { dismiss() }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(sending) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(sending ? "Saving…" : "Save") { run { await save(name) } }
                        .disabled(sending || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("rename.save")
                }
            }
        }
        .presentationDetents([.height(AceTheme.Dimensions.touchTarget * 4.5)])
        .presentationDragIndicator(.visible)
        .task {
            name = title
            focused = true
            // The whole name selected once the field has the keyboard: typing replaces it, as the
            // system's own rename does.
            try? await Task.sleep(for: .milliseconds(80))
            selection = TextSelection(range: name.startIndex..<name.endIndex)
        }
    }
    private func run(_ action: @escaping () async -> String?) {
        guard !sending else { return }
        sending = true
        problem = nil
        Task {
            let refused = await action()
            sending = false
            if let refused { problem = refused; return }
            done()
            dismiss()
        }
    }
}

/// Bring back to parent: a summary of the fork's work, its newest answer to start with, sent to
/// the thread it was forked from, whose agent reads it on its next turn. The fork stays.
private struct MergeSheet: View {
    let model: ClientModel
    let screen: ThreadScreenModel
    let opened: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var summary = ""
    @State private var includeCode = false
    @State private var sending = false
    @State private var problem: String?
    @State private var started = false
    private var parent: String? { screen.transitions?.parent?.threadId }
    private var parentTitle: String { parent.flatMap { model.inbox[$0]?.title } ?? "the parent thread" }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.lg) {
                    Text("Send a summary to \(parentTitle). Its agent reads it on the next turn. This fork stays available.")
                        .aceFont(AceTheme.Typography.body, relativeTo: .body)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                        InsetHeader("Summary")
                        TextEditor(text: $summary)
                            .aceFont(AceTheme.Typography.body, relativeTo: .body)
                            .scrollContentBackground(.hidden)
                            .frame(minHeight: AceTheme.Dimensions.touchTarget * 4)
                            .padding(AceTheme.Spacing.sm)
                            .background(AceTheme.Colours.fill, in: AceShape.field)
                            .disabled(sending)
                            .accessibilityIdentifier("merge.summary")
                    }
                    Toggle("Include code changes", isOn: $includeCode).toggleStyle(.systemSwitch).disabled(sending)
                        .accessibilityIdentifier("merge.code")
                    Text("Includes uncommitted tracked changes only. Both threads must finish before code changes can be applied.")
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.subtleForeground)
                    if screen.mergeDraft?.ready == false {
                        Text("Wait for an answer in this fork before bringing results back.")
                            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                            .foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                    if let problem {
                        Text(problem).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                            .foregroundStyle(AceTheme.StatusText.failed).accessibilityIdentifier("merge.problem")
                    }
                }
                .padding(.horizontal, AceTheme.Spacing.xl).padding(.top, AceTheme.Spacing.sm)
            }
            .background(AceTheme.Colours.background)
            .navigationTitle("Bring back to parent")
            .navigationBarTitleDisplayMode(.inline)
            .escapeCloses { dismiss() }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(sending) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(sending ? "Sending…" : "Bring back") { send() }
                        .disabled(sending || screen.mergeDraft?.ready != true || summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("merge.send")
                }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .onAppear { model.readMergeDraft() }
        .onChange(of: screen.mergeDraft, initial: true) { _, draft in
            if !started, let draft { summary = draft.summary; started = true }
        }
    }
    private func send() {
        sending = true
        problem = nil
        Task {
            let refused = await model.bringBack(summary: summary, includeCode: includeCode)
            sending = false
            if let refused { problem = refused; return }
            dismiss()
            if let parent { opened(parent) }
        }
    }
}

private struct TurnsPage: Decodable {
    struct Turn: Decodable, Identifiable {
        let ordinal: Int
        let startedAt: Double
        let outcome: String
        let ask: String
        let reply: String
        var id: Int { ordinal }
    }
    let turns: [Turn]
    let older: Int?
    let ready: Bool
}

/// The thread's turns, newest first: each ask on one line with the reply's opening under it.
/// Tapping one brings its ask into view. Earlier turns load as the list reaches them.
private struct TurnsSheet: View {
    let model: ClientModel
    let threadId: String
    let jump: (Int) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var turns: [TurnsPage.Turn] = []
    @State private var older: Int?
    @State private var loading = false
    @State private var loaded = false
    @State private var problem: String?
    var body: some View {
        NavigationStack {
            List {
                ForEach(turns) { turn in
                    Button {
                        dismiss()
                        jump(turn.ordinal)
                    } label: {
                        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                            HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
                                Text(turn.ask.isEmpty ? "No text in this ask" : turn.ask)
                                    .aceFont(AceTheme.Typography.body, relativeTo: .body).fontWeight(.medium)
                                    .foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
                                Spacer(minLength: AceTheme.Spacing.sm)
                                Text("\(turn.ordinal)").aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                                    .foregroundStyle(AceTheme.Colours.subtleForeground).monospacedDigit()
                                    .accessibilityLabel("Turn \(turn.ordinal)")
                            }
                            Text(turn.reply.isEmpty ? (turn.outcome == "active" ? "Working…" : "No reply yet") : turn.reply)
                                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                                .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(2)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, AceTheme.Spacing.xs)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(RowPressStyle())
                    .listRowSeparator(.hidden)
                    .listRowBackground(AceTheme.Colours.background)
                    .accessibilityIdentifier("turn.\(turn.ordinal)")
                    .onAppear { if turn.id == turns.last?.id { load() } }
                }
                if loading || problem != nil || (loaded && turns.isEmpty) {
                    Group {
                        if let problem {
                            Button("Try again") { load() }.foregroundStyle(AceTheme.Colours.foreground)
                            Text(problem).foregroundStyle(AceTheme.Colours.mutedForeground)
                        } else if loading {
                            ProgressView().frame(maxWidth: .infinity)
                        } else {
                            Text("No turns yet.").foregroundStyle(AceTheme.Colours.mutedForeground)
                        }
                    }
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .listRowSeparator(.hidden)
                    .listRowBackground(AceTheme.Colours.background)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AceTheme.Colours.background)
            .navigationTitle("Turns")
            .navigationBarTitleDisplayMode(.inline)
            .escapeCloses { dismiss() }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel("Close")
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .task { load() }
    }
    private func load() {
        guard !loading, !loaded || older != nil else { return }
        loading = true
        problem = nil
        Task {
            defer { loading = false }
            var payload: [String: Any] = ["type": "native.turns", "threadId": threadId]
            if let older { payload["before"] = older }
            do {
                let page = try await model.service(payload, as: TurnsPage.self)
                turns += page.turns.filter { turn in !turns.contains { $0.id == turn.id } }
                older = page.older
                loaded = true
            } catch {
                problem = error.localizedDescription
            }
        }
    }
}

private struct ThreadFilesPage: Decodable {
    struct File: Decodable, Identifiable {
        let ref: String
        let name: String
        let size: String
        let mimeType: String
        let kind: String
        var id: String { ref }
    }
    let files: [File]
}

/// Files stored for the thread, from every message. Removing one frees its space and stops it
/// opening from older messages, so it asks first.
private struct ThreadFilesSheet: View {
    let model: ClientModel
    let threadId: String
    @Environment(\.dismiss) private var dismiss
    @State private var files: [ThreadFilesPage.File]?
    @State private var problem: String?
    @State private var removing: ThreadFilesPage.File?
    @State private var busy: String?
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Files stored for this thread. Removing a file frees space and stops it opening from older messages.")
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                        .listRowSeparator(.hidden).listRowBackground(AceTheme.Colours.background)
                }
                if let files {
                    if files.isEmpty {
                        Text("No attachments in this thread.").foregroundStyle(AceTheme.Colours.mutedForeground)
                            .listRowSeparator(.hidden).listRowBackground(AceTheme.Colours.background)
                    }
                    ForEach(files) { file in
                        HStack(spacing: AceTheme.Spacing.md) {
                            AceIcon(file.kind == "image" ? .image : .fileText, size: 18).foregroundStyle(AceTheme.Colours.mutedForeground)
                            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                                Text(file.name).lineLimit(1).truncationMode(.middle).foregroundStyle(AceTheme.Colours.foreground)
                                Text(file.size).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                                    .foregroundStyle(AceTheme.Colours.subtleForeground)
                            }
                            Spacer(minLength: AceTheme.Spacing.sm)
                            if model.canOperate {
                                Button(busy == file.ref ? "Removing…" : "Remove") { removing = file }
                                    .buttonStyle(.plain).foregroundStyle(AceTheme.StatusText.failed)
                                    .disabled(busy != nil)
                                    .accessibilityLabel("Remove \(file.name)")
                            }
                        }
                        .frame(minHeight: AceTheme.Dimensions.touchTarget)
                        .listRowSeparator(.hidden).listRowBackground(AceTheme.Colours.background)
                    }
                } else if problem == nil {
                    ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden).listRowBackground(AceTheme.Colours.background)
                }
                if let problem {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                        Text(problem).foregroundStyle(AceTheme.Colours.mutedForeground)
                        Button("Try again") { load() }.foregroundStyle(AceTheme.Colours.foreground)
                    }
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .listRowSeparator(.hidden).listRowBackground(AceTheme.Colours.background)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AceTheme.Colours.background)
            .navigationTitle("Attachments")
            .navigationBarTitleDisplayMode(.inline)
            .escapeCloses { dismiss() }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel("Close")
                }
            }
            .alert("Remove \(removing?.name ?? "this file")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
                Button("Cancel", role: .cancel) {}
                Button("Remove", role: .destructive) { if let file = removing { load(release: file.ref) } }
            } message: {
                Text("It frees space and stops opening from older messages.")
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .task { load() }
    }
    private func load(release: String? = nil) {
        problem = nil
        busy = release
        Task {
            defer { busy = nil }
            var payload: [String: Any] = ["type": "native.threadFiles", "threadId": threadId]
            if let release { payload["release"] = release }
            do { files = try await model.service(payload, as: ThreadFilesPage.self).files }
            catch { problem = error.localizedDescription }
        }
    }
}

/// Rename from a list row: the same alert as the thread's header, on the row's own machine.
struct InboxRename: ViewModifier {
    let inbox: MachineInbox
    @Binding var key: InboxKey?
    func body(content: Content) -> some View {
        content.modifier(RenameThread(model: key.flatMap { inbox.client($0.machineId) }, threadId: key?.id ?? "",
                                      title: key.flatMap { inbox.row($0)?.title } ?? "",
                                      isPresented: Binding(get: { key != nil }, set: { if !$0 { key = nil } })))
    }
}
