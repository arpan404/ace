import SwiftUI

/// One machine's Storage: what its data takes, a reviewed cleanup (preview, then a red removal
/// whose confirmation says what goes), compaction, worktrees and how long each kind of data is
/// kept. Every word comes from `bridge/host-storage.ts`; this draws it.
struct StorageView: View {
    let model: ClientModel
    @State private var page: StoragePage?
    @State private var problem: String?
    @State private var plan: StoragePlanView?
    @State private var forced: Set<String> = []
    /// The preview shown covers every settled worktree, not the usual cleanup.
    @State private var worktreePreview = false
    @State private var confirming = false
    @State private var compaction: StorageCompactionReply?
    @State private var busy = false
    @State private var actionProblem: String?
    @State private var removals = 0
    private static let read: [String: Any] = ["type": "host.storage"]

    /// Opens on the last page this phone saw, read again behind it.
    init(model: ClientModel) {
        self.model = model
        _page = State(initialValue: model.kept(Self.read, as: StoragePage.self))
    }

    var body: some View {
        List {
            Group {
                usage
                if let plan { planSection(plan).transition(.opacity) }
                if let settings = page?.settings {
                    Group {
                        StorageWorktreeSection(settings: settings, busy: busy, save: save) { preview(worktrees: true) }
                        StorageWindowSection(settings: settings, save: save)
                        StorageKindsSection(settings: settings, save: save)
                    }
                    .disabled(!model.canOperate)
                } else if problem == nil {
                    Section { ForEach(0..<3, id: \.self) { _ in Text("Retention").redacted(reason: .placeholder) } }
                }
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .animation(.smooth, value: plan)
        .animation(.smooth, value: page)
        .sensoryFeedback(.success, trigger: removals)
        .navigationTitle("Storage").navigationBarTitleDisplayMode(.inline)
        .readWhenConnected(model, id: model.readGeneration(Self.read)) { await load() }
        .refreshable { await load() }
    }

    @ViewBuilder private var usage: some View {
        Section {
            if let usage = page?.usage {
                ForEach(usage.rows) { row in
                    LabeledContent { Text(row.size).monospacedDigit() } label: {
                        Text(row.title)
                        Text(row.detail)
                    }
                }
                LabeledContent { Text(usage.database.size).monospacedDigit() } label: {
                    Text("Transcript database")
                    Text(compaction?.line ?? usage.database.detail)
                }
                if let partial = usage.partial { quiet(partial) }
                if let backups = usage.backups {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                        Text(backups.line).foregroundStyle(AceTheme.StatusText.failed)
                        ForEach(backups.paths, id: \.self) { Text($0).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption2) }
                    }
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                }
            } else if let message = page?.usageProblem ?? problem {
                ServiceProblem(message: message)
                Button("Retry") { Task { await load() } }
            } else {
                ForEach(0..<4, id: \.self) { _ in LabeledContent("Threads and transcripts", value: "0.0 MB").redacted(reason: .placeholder) }
            }
            if model.canOperate, page?.usage != nil {
                Button("Preview cleanup") { preview(worktrees: false) }
                    .disabled(busy).accessibilityIdentifier("storage.preview")
                if let pending = compaction?.pendingId {
                    Button("Resume compaction") { compact(nil) }.disabled(busy)
                    Button("Stop compaction") { compact(pending) }.disabled(busy)
                } else {
                    Button("Compact database") { compact(nil) }.disabled(busy).accessibilityIdentifier("storage.compact")
                }
            }
            ServiceProblem(message: actionProblem)
        } header: {
            HStack { InsetHeader("Usage"); Spacer(); if busy { ProgressView().controlSize(.mini) } }
        }
    }

    private func planSection(_ plan: StoragePlanView) -> some View {
        Section {
            quiet(plan.summary)
            ForEach(plan.items) { item in
                StoragePlanRow(item: item, forced: Binding(
                    get: { forced.contains(item.id) },
                    set: { on in if on { forced.insert(item.id) } else { forced.remove(item.id) } }))
            }
            if let outcome = plan.outcome { Text(outcome).accessibilityIdentifier("storage.outcome") }
            if !forced.isEmpty {
                Button("Preview with selected worktrees") { preview(worktrees: worktreePreview) }.disabled(busy)
            } else if let action = plan.action, model.canOperate {
                Button(action, role: .destructive) { confirming = true }
                    .disabled(busy).accessibilityIdentifier("storage.remove")
            }
        } header: { InsetHeader(plan.title) }
        .confirmationDialog(plan.confirm?.title ?? "", isPresented: $confirming, titleVisibility: .visible) {
            Button(plan.confirm?.button ?? "Remove items", role: .destructive) { apply(plan) }
                .accessibilityIdentifier("storage.remove.confirm")
        } message: { Text(plan.confirm?.message ?? "") }
    }

    private func quiet(_ text: String) -> some View {
        Text(text).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
    }

    private func load() async {
        do {
            page = try await model.read(Self.read, as: StoragePage.self)
            problem = nil
        } catch is CancellationError {} catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
    private func run(_ work: @escaping @MainActor () async throws -> Void) {
        busy = true; actionProblem = nil
        Task {
            defer { busy = false }
            do { try await work() } catch is CancellationError {} catch { actionProblem = error.localizedDescription }
        }
    }
    private func preview(worktrees: Bool) {
        run {
            let reply = try await model.service(["type": "host.storage.preview", "worktrees": worktrees, "forceItems": Array(forced)], as: StoragePlanReply.self, timeout: .seconds(70))
            forced = []
            worktreePreview = worktrees
            plan = reply.plan
        }
    }
    private func apply(_ shown: StoragePlanView) {
        run {
            plan = try await model.service(["type": "host.storage.apply", "planId": shown.id], as: StoragePlanReply.self, timeout: .seconds(70)).plan
            removals += 1
            await load()
        }
    }
    private func compact(_ abandon: String?) {
        run {
            var request: [String: Any] = ["type": "host.storage.compact"]
            if let abandon { request["abandon"] = abandon }
            compaction = try await model.service(request, as: StorageCompactionReply.self, timeout: .seconds(70))
            await load()
        }
    }
    /// Saves one storage setting; the reply is the page as the machine now has it.
    private func save(_ setting: [String: Any]) async throws {
        page = try await model.service(["type": "host.storage.set", "setting": setting], as: StoragePage.self)
        plan = nil; forced = []
    }
}

/// One item of a cleanup preview: what it is, its size, what happens to it and why.
private struct StoragePlanRow: View {
    let item: StoragePlanView.Item
    @Binding var forced: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            HStack(alignment: .firstTextBaseline) {
                Text(item.label).lineLimit(2).truncationMode(.middle)
                Spacer(minLength: AceTheme.Spacing.sm)
                Text(item.size).monospacedDigit().foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            Group {
                Text(item.line)
                if let also = item.also { Text(also) }
                if let outcome = item.outcome { Text(outcome).foregroundStyle(AceTheme.Colours.foreground) }
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
            if item.forceable, item.outcome == nil {
                Toggle("Include despite uncommitted or unpushed work", isOn: $forced)
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            }
        }
        .padding(.vertical, AceTheme.Spacing.xxs)
    }
}
