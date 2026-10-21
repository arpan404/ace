import SwiftUI

/// Install a plugin from a Git repository: the repository, ref and name, then a review of what
/// it runs before anything is installed.
struct PluginInstallView: View {
    let model: ClientModel
    @Environment(\.dismiss) private var dismiss
    @State private var repository = ""
    @State private var ref = "HEAD"
    @State private var name = ""
    @State private var review: PluginReviewRequest?
    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("Git repository", text: $repository).aceMonospace(SettingsStyle.value, relativeTo: .body)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Branch or commit", text: $ref).aceMonospace(SettingsStyle.value, relativeTo: .body)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Plugin name", text: $name).aceFont(SettingsStyle.label, relativeTo: .body)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                } header: { SettingsHeader("Plugin", note: "Review what the plugin runs before installing it on your machine.") }
                .settingsRow()
                Section {
                    Button {
                        review = PluginReviewRequest(operation: ["type": "plugins.prepare", "repository": repository, "ref": ref, "name": name])
                    } label: { SettingsActionLabel(title: "Review installation") }
                    .buttonStyle(.plain)
                    .disabled(repository.isEmpty || ref.isEmpty || name.isEmpty || !model.canOperate)
                }
                .settingsRow()
            }
            .settingsList()
            .navigationTitle("Install plugin").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .sheet(item: $review) { PluginReviewView(model: model, request: $0, installed: { dismiss() }) }
        }
    }
}

/// What a plugin install or edit would run, read in full and pinned to one commit and hash
/// before it can be accepted.
struct PluginReviewView: View {
    let model: ClientModel
    let request: PluginReviewRequest
    var installed: () -> Void = {}
    @Environment(\.dismiss) private var dismiss
    @State private var review: NativePluginReview?
    @State private var entries: [ServiceValue] = []
    @State private var complete = false
    @State private var busy = false
    @State private var accepted = false
    @State private var problem: String?
    var body: some View {
        NavigationStack {
            List {
                if let review {
                    Section {
                        SettingsRow("Name", value: review.name).accessibilityElement(children: .combine)
                        SettingsRow("Version", value: review.version).accessibilityElement(children: .combine)
                        pinned("Commit", review.commit)
                        pinned("Content hash", review.hash)
                    } header: { SettingsHeader("Plugin") }
                    .settingsRow()
                    Section {
                        ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                            Text(pluginReviewText(entry)).aceMonospace(AceTheme.Typography.code, relativeTo: .footnote)
                                .foregroundStyle(AceTheme.Colours.foreground).textSelection(.enabled)
                        }
                        if complete && entries.isEmpty {
                            Text("No hooks or MCP servers declared.").aceFont(SettingsStyle.value, relativeTo: .body)
                                .foregroundStyle(AceTheme.Colours.mutedForeground)
                        }
                        if !complete && problem == nil { readingBars }
                    } header: { SettingsHeader("What it runs") }
                    .settingsRow()
                    Section {
                        Button { accept() } label: {
                            HStack(spacing: AceTheme.Spacing.sm) {
                                SettingsActionLabel(title: "Accept and install")
                                if busy && complete { ProgressView() }
                            }
                        }
                        .buttonStyle(.plain)
                        .disabled(!complete || busy || !model.canOperate)
                        .accessibilityIdentifier("plugins.accept")
                    } header: {
                        SettingsHeader("Install", note: "Only accept code and endpoints you trust. Installation uses the exact commit and hash shown above.")
                    }
                    .settingsRow()
                    if let problem {
                        Section {
                            ServiceProblem(message: problem)
                            Text("Close and retry from Skills. Pending reviews remain available there.")
                                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                        }
                        .settingsRow()
                    }
                } else if let problem {
                    EmptyState(icon: nil, title: "Couldn't read the review",
                               line: "\(problem) Close and retry from Skills. Pending reviews remain available there.", failed: true)
                        .accessibilityIdentifier("service.problem")
                        .padding(.top, AceTheme.Spacing.xxxl).listRowBackground(Color.clear).listRowSeparator(.hidden)
                } else {
                    Section { readingBars } header: { SettingsHeader("Plugin") }
                        .settingsRow()
                }
            }
            .settingsList()
            .navigationTitle("Review plugin").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) } }
        }
        .interactiveDismissDisabled(busy)
        .task { await prepare() }
        .onDisappear {
            if let review, !accepted { Task { _ = try? await model.plugin(["type": "plugins.cancel", "id": review.id], expecting: "plugins.cancelled") } }
        }
    }
    /// A commit or hash: mono, cut in the middle so both ends stay readable, and selectable.
    private func pinned(_ title: String, _ value: String) -> some View {
        SettingsRow(title: title) {
            Text(value).aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.subtleForeground).lineLimit(1).truncationMode(.middle)
                .textSelection(.enabled)
        }
        .accessibilityElement(children: .combine)
    }
    /// The review while it's read: a few skeleton lines.
    private var readingBars: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            ForEach([200, 240, 160], id: \.self) { width in
                Capsule().fill(AceTheme.Colours.fill).frame(width: CGFloat(width), height: 10)
            }
        }
        .padding(.vertical, AceTheme.Spacing.xs)
        .accessibilityElement(children: .ignore).accessibilityLabel("Reading review")
    }
    private func prepare() async {
        busy = true
        defer { busy = false }
        do {
            let first: PluginResponseRow
            if request.operation["type"] as? String == "plugins.readReview" {
                first = try await model.plugin(request.operation, expecting: "plugins.reviewPage")
            } else {
                first = try await model.plugin(request.operation, expecting: "plugins.review")
            }
            guard let made = first.review else { throw ServiceFailure(message: "The machine returned no review.") }
            review = made
            var offset = 0
            var collected: [ServiceValue] = []
            for _ in 0..<1025 {
                let page = try await model.plugin(["type": "plugins.readReview", "id": made.id, "offset": offset], expecting: "plugins.reviewPage")
                guard let summary = page.review, summary.id == made.id, summary.hash == made.hash, summary.commit == made.commit else {
                    throw ServiceFailure(message: "The review changed while reading. Close and try again.")
                }
                collected += page.entries ?? []
                if let next = page.nextOffset {
                    guard next > offset, collected.count <= 1024 else { throw ServiceFailure(message: "Invalid review page. Close and try again.") }
                    offset = next
                } else {
                    guard collected.count == (summary.executionCount ?? 0) + (summary.unsupportedCount ?? 0) else {
                        throw ServiceFailure(message: "The review is incomplete. Close and try again.")
                    }
                    entries = collected; complete = true; return
                }
            }
            throw ServiceFailure(message: "The review exceeds its supported size.")
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
    private func accept() {
        guard complete, !busy, let review else { return }
        busy = true; problem = nil
        Task {
            defer { busy = false }
            do {
                _ = try await model.plugin(["type": "plugins.accept", "id": review.id, "commit": review.commit, "hash": review.hash], expecting: "plugins.installed")
                accepted = true; dismiss(); installed()
            } catch { problem = error.localizedDescription }
        }
    }
}

