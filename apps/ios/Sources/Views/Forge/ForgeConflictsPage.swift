import SwiftUI

/// A pull request's merge conflicts as a page, resolved in a linked thread's checkout (the web's
/// conflicts view): merge the base in, then each file hunk by hunk (ours, theirs, both, or your
/// own text) or a whole side for a file without hunks, or hand a file to the thread's agent.
/// "Finish and push" commits the merge and pushes the head branch; "Abort merge" is red and asked
/// first. Every step is one command, and the checkout is read again after it.
struct ForgeConflictsPageView: View {
    let client: ClientModel
    let route: ForgeRoute
    let openThread: (InboxKey) -> Void
    @State private var threadId: String?
    @State private var page: ForgeConflicts?
    @State private var failure: String?
    @State private var writing: String?
    @State private var outcome: ForgeWorkOutcome?
    @State private var aborting = false
    @State private var editing: Editing?
    @Environment(\.threadDrafts) private var drafts

    struct Editing: Identifiable { let file: ForgeConflicts.File; let hunk: Int; var text: String; var id: String { "\(file.path)#\(hunk)" } }

    private var request: [String: Any] { ClientModel.forgeConflictsRead(route, threadId: threadId) }

    var body: some View {
        ScrollView {
            if let page { content(page).transition(.opacity) }
            else if let failure {
                EmptyState(icon: nil, title: "Couldn't read the conflicts", line: failure, failed: true) {
                    Button("Try again") { Task { await load() } }
                }
                .padding(.top, 120)
            } else {
                ProgressView().padding(.top, 120).frame(maxWidth: .infinity)
            }
        }
        .animation(.smooth, value: page)
        .background(AceTheme.Colours.background)
        .refreshable { await load() }
        .navigationTitle("Merge conflicts")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: "\(threadId ?? "")|\(client.readGeneration(request))") { await load() }
        .sensoryFeedback(.success, trigger: outcome) { _, now in now?.ok == true }
        .confirmationDialog("Abort the merge?", isPresented: $aborting, titleVisibility: .visible) {
            Button("Abort merge", role: .destructive) { step(["action": "abort"], key: "abort") }
        } message: { Text("The checkout goes back to its last commit. Resolutions so far are lost.") }
        .sheet(item: $editing) { edit in
            ForgeHunkEditor(path: edit.file.path, text: edit.text) { text in
                resolve(edit.file, hunk: edit.hunk, choice: ["kind": "edit", "text": text])
            }
        }
    }

    @ViewBuilder private func content(_ page: ForgeConflicts) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.lg) {
            Text("\(page.baseBranch) into \(page.headBranch)").aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.subtleForeground).padding(.horizontal, AceTheme.Spacing.lg)
            ForgeThreadPicker(threads: page.threads, chosen: page.threadId) { threadId = $0 }
            ForgeOutcomeLine(outcome: outcome, identifier: "forge.conflicts.outcome")
            if let note = page.note { Text(note).meta().padding(.horizontal, AceTheme.Spacing.lg) }
            if let checkout = page.checkout { checkoutView(checkout, page) }
        }
        .padding(.vertical, AceTheme.Spacing.md)
    }

    @ViewBuilder private func checkoutView(_ checkout: ForgeConflicts.Checkout, _ page: ForgeConflicts) -> some View {
        let ready = client.canOperate && writing == nil
        if !checkout.merging {
            Text(checkout.dirty ? "The checkout has uncommitted changes. Commit or move them before merging." : "Merge \(page.baseBranch) into this checkout to see its conflicts.")
                .meta().padding(.horizontal, AceTheme.Spacing.lg)
            if client.canOperate, let head = checkout.head {
                ForgeTextAction(label: "Merge \(page.baseBranch) in", reason: checkout.dirty ? "Commit or move the changes first." : nil,
                                busy: writing == "start", identifier: "forge.conflicts.start") { step(["action": "start", "head": head], key: "start") }
            }
        } else {
            ForEach(checkout.files, id: \.path) { file in fileSection(file, ready: ready) }
            if checkout.truncated { Text("More conflicted files are in the checkout.").meta().padding(.horizontal, AceTheme.Spacing.lg) }
            if client.canOperate {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    if let head = checkout.head {
                        ForgeTextAction(label: "Finish and push", reason: checkout.files.isEmpty ? nil : "Resolve every file first.",
                                        busy: writing == "finish", identifier: "forge.conflicts.finish") { step(["action": "finish", "head": head], key: "finish") }
                    }
                    ForgeTextAction(label: "Abort merge", destructive: true, busy: writing == "abort", identifier: "forge.conflicts.abort") { aborting = true }
                }
            }
        }
    }

    private func fileSection(_ file: ForgeConflicts.File, ready: Bool) -> some View {
        ForgeSection(title: file.path) {
            if let reason = file.unavailable {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                    Text(reason).meta()
                    HStack(spacing: AceTheme.Spacing.lg) {
                        Button("Take ours") { step(["action": "take", "path": file.path, "side": "ours"], key: file.path) }
                        Button("Take theirs") { step(["action": "take", "path": file.path, "side": "theirs"], key: file.path) }
                    }
                    .disabled(!ready).frame(minHeight: 44)
                }
                .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.xs)
            }
            ForEach(Array(file.hunks.enumerated()), id: \.offset) { index, hunk in
                hunkView(file, index: index, hunk: hunk, ready: ready)
            }
            HStack {
                Button("Ask the agent") { ask(file) }.disabled(!client.canOperate)
                if writing == file.path { ProgressView().controlSize(.small).transition(.opacity) }
            }
            .padding(.horizontal, AceTheme.Spacing.lg).frame(minHeight: 44)
            .accessibilityIdentifier("forge.conflicts.ask.\(file.path)")
        }
        .buttonStyle(.borderless)
        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
    }

    private func hunkView(_ file: ForgeConflicts.File, index: Int, hunk: ForgeConflicts.Hunk, ready: Bool) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            side("Ours", hunk.ours)
            side("Theirs", hunk.theirs)
            HStack(spacing: AceTheme.Spacing.lg) {
                Button("Ours") { resolve(file, hunk: index, choice: ["kind": "ours"]) }
                Button("Theirs") { resolve(file, hunk: index, choice: ["kind": "theirs"]) }
                Button("Both") { resolve(file, hunk: index, choice: ["kind": "both"]) }
                Button("Edit") { editing = Editing(file: file, hunk: index, text: hunk.draft) }
            }
            .disabled(!ready || file.revision == nil)
            .frame(minHeight: 44)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("forge.conflicts.hunk.\(file.path).\(index)")
        }
        .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.sm)
    }

    private func side(_ label: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            Text(label).meta()
            Text(verbatim: text.isEmpty ? "(nothing)" : text).aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.foreground).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func ask(_ file: ForgeConflicts.File) {
        guard let threadId = page?.threadId else { return }
        if client.handOff(file.request, to: threadId, drafts: drafts) { openThread(InboxKey(machineId: route.machineId, id: threadId)) }
        else { outcome = ForgeWorkOutcome(ok: false, message: "Couldn't add the request. Open the thread and try again.", uncertain: false) }
    }

    private func resolve(_ file: ForgeConflicts.File, hunk: Int, choice: [String: Any]) {
        guard let revision = file.revision else { return }
        step(["action": "resolve", "path": file.path, "revision": revision, "hunk": hunk, "choice": choice], key: file.path)
    }

    private func step(_ step: [String: Any], key: String) {
        guard writing == nil, let repository = route.repository, let threadId = page?.threadId else { return }
        writing = key
        Task {
            outcome = await client.forgeWorkWrite(["type": "forge.conflicts", "project": route.project, "number": route.number,
                                                    "repository": repository.json, "threadId": threadId, "step": step])
            await load()
            writing = nil
        }
    }

    /// Always read afresh: the checkout changes under every step.
    private func load() async {
        do {
            page = try await client.forgeWorkRead(request, fresh: true, as: ForgeConflicts.self)
            failure = nil
        }
        catch is CancellationError {}
        catch { if page == nil { failure = error.localizedDescription } }
    }
}

/// One hunk's text to write by hand, starting from both sides.
struct ForgeHunkEditor: View {
    let path: String
    @State var text: String
    let save: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            TextEditor(text: $text)
                .font(.system(.footnote, design: .monospaced))
                .padding(.horizontal, AceTheme.Spacing.md)
                .accessibilityIdentifier("forge.conflicts.editor")
                .navigationTitle(path).navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Use this") { save(text); dismiss() }
                            .disabled(text.contains("<<<<<<<") || text.contains(">>>>>>>"))
                            .accessibilityIdentifier("forge.conflicts.editor.save")
                    }
                }
        }
        .presentationDetents([.medium, .large])
    }
}
