import SwiftUI

/// What a plugin would run, before it is installed: the commit and hash it comes from, every
/// entry it declares, then Accept and install. Cardless, as the design language's inner pages.
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
            ScrollView {
                VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                    if let review {
                        QuietSection("Plugin") {
                            detail("Name", review.name)
                            detail("Version", review.version)
                            detail("Commit", review.commit, mono: true)
                            detail("Content hash", review.hash, mono: true)
                        }
                        entriesList
                    }
                    if busy || (review == nil && problem == nil) {
                        SkeletonRows(count: 3, label: "Reading review")
                    }
                    if let problem {
                        QuietProblem(message: problem, id: "plugins.review.problem")
                        Text("Close and retry from Skills. Pending reviews remain available there.")
                            .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                            .foregroundStyle(AceDesign.Ink.muted)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.horizontal, AceDesign.Space.margin)
                    }
                    if review != nil {
                        Button("Accept and install") { accept() }
                            .buttonStyle(.textAction(.prominent))
                            .disabled(!complete || busy || !model.canOperate)
                            .padding(.horizontal, AceDesign.Space.margin)
                            .accessibilityIdentifier("plugins.accept")
                        Text("Only accept code and endpoints you trust. Installation uses the exact commit and hash shown above.")
                            .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                            .foregroundStyle(AceDesign.Ink.muted)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.horizontal, AceDesign.Space.margin)
                    }
                }
                .padding(.top, AceDesign.Space.related).padding(.bottom, AceDesign.Space.group)
                .animation(.default, value: busy)
            }
            .background(AceDesign.Surface.background)
            .navigationTitle("Review plugin").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) } }
        }
        .interactiveDismissDisabled(busy)
        .task { await prepare() }
        .onDisappear {
            if let review, !accepted { Task { _ = try? await model.plugin(["type": "plugins.cancel", "id": review.id], expecting: "plugins.cancelled") } }
        }
    }

    /// One of the review's own facts: its name, then the value, in mono for a commit or a hash.
    private func detail(_ label: String, _ value: String, mono: Bool = false) -> some View {
        QuietSectionRow {
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                Text(label).aceFont(AceDesign.TextRole.rowTitle, relativeTo: .callout)
                    .foregroundStyle(AceDesign.Ink.primary)
                Text(verbatim: value)
                    .aceMonospace(AceDesign.TextRole.code, relativeTo: .caption)
                    .foregroundStyle(AceDesign.Ink.muted)
                    .textSelection(.enabled)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// Every entry the plugin declares, read lazily: a review can hold a thousand of them.
    private var entriesList: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            QuietHeading("What it runs")
                .padding(.horizontal, AceDesign.Space.margin).padding(.bottom, AceDesign.Space.tight)
            if complete, entries.isEmpty {
                QuietSectionRow { QuietRowText(title: "No hooks or MCP servers declared.", tone: AceDesign.Ink.muted) }
            } else {
                LazyVStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    ForEach(Array(entries.enumerated()), id: \.offset) { index, entry in
                        if index > 0 { Hairline().padding(.leading, AceDesign.Space.margin) }
                        QuietSectionRow {
                            Text(pluginReviewText(entry))
                                .aceMonospace(AceDesign.TextRole.code, relativeTo: .caption)
                                .foregroundStyle(AceDesign.Ink.muted)
                                .textSelection(.enabled)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
