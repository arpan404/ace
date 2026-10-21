import SwiftUI

struct PluginInstallView: View {
    let model: ClientModel
    @Environment(\.dismiss) private var dismiss
    @State private var repository = ""
    @State private var ref = "HEAD"
    @State private var name = ""
    @State private var review: PluginReviewRequest?
    var body: some View {
        NavigationStack {
            Form {
                TextField("Git repository", text: $repository).textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("Branch or commit", text: $ref).textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("Plugin name", text: $name).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("Review installation") {
                    review = PluginReviewRequest(operation: ["type": "plugins.prepare", "repository": repository, "ref": ref, "name": name])
                }.disabled(repository.isEmpty || ref.isEmpty || name.isEmpty || !model.canOperate)
                Text("Review what the plugin runs before installing it on your machine.")
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            .navigationTitle("Install plugin").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .sheet(item: $review) { PluginReviewView(model: model, request: $0, installed: { dismiss() }) }
        }
    }
}

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
                    Section("Plugin") {
                        LabeledContent("Name", value: review.name)
                        LabeledContent("Version", value: review.version)
                        LabeledContent("Commit", value: review.commit).textSelection(.enabled)
                        LabeledContent("Content hash", value: review.hash).textSelection(.enabled)
                    }
                    Section("What it runs") {
                        ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                            Text(pluginReviewText(entry)).aceMonospace(AceTheme.Typography.code, relativeTo: .footnote).textSelection(.enabled)
                        }
                        if complete && entries.isEmpty { Text("No hooks or MCP servers declared.") }
                    }
                    Section {
                        Button("Accept and install") { accept() }.disabled(!complete || busy || !model.canOperate)
                            .accessibilityIdentifier("plugins.accept")
                    } footer: { Text("Only accept code and endpoints you trust. Installation uses the exact commit and hash shown above.") }
                }
                if busy || (review == nil && problem == nil) { ProgressView("Reading review…") }
                ServiceProblem(message: problem)
                if problem != nil { Text("Close and retry from Skills. Pending reviews remain available there.") }
            }
            .navigationTitle("Review plugin").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) } }
        }
        .interactiveDismissDisabled(busy)
        .task { await prepare() }
        .onDisappear {
            if let review, !accepted { Task { _ = try? await model.plugin(["type": "plugins.cancel", "id": review.id], expecting: "plugins.cancelled") } }
        }
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
