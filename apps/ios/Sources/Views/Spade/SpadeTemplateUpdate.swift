import SwiftUI

/// The update review of a bot made from one of ace's templates (ADR 0200 §3.8, §6.1), when the
/// Spade it runs on ships a newer version: what changes, what stays because the person or the
/// bot changed it, what it asks for that starts off, and every effect the new version declares.
/// Nothing changes until the person presses Update and confirms, and then only to the very
/// version they read.
struct SpadeTemplateUpdate: View {
    let scope: SpadeProfileScope
    let version: String
    let updated: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var answer: SpadePackageAnswer?
    /// The offer the confirmation names and takes: the one read and shown, never a later read.
    @State private var confirming: SpadeTemplateOffer?
    @State private var saving = false
    @State private var problem: String?

    var body: some View {
        List {
            if let offer = answer?.offer {
                Section {
                    Text("ace's \(offer.name) template \(offer.version) came with this Spade. Nothing changes until you update.")
                        .aceFont(AceDesign.TextRole.message)
                        .foregroundStyle(AceDesign.Ink.primary)
                }
                lines("What changes", offer.changes)
                lines("Stays because you changed it", offer.kept)
                lines("Asks for more", offer.more)
                if !offer.effects.isEmpty {
                    Section("What it may do") {
                        ForEach(offer.effects, id: \.self) { effect in
                            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                                Text(effect.words).aceFont(AceDesign.TextRole.rowTitle)
                                ForEach(effect.limits, id: \.self) { limit in
                                    Text("Only with \(limit)").aceFont(AceDesign.TextRole.meta)
                                }
                                Text(effect.why).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                }
                if let problem {
                    Section { Text(problem).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceTheme.StatusText.failed) }
                }
            } else if let problem = answer?.problem {
                ProblemRow(problem, id: "spade.template.problem") { Task { await load() } }
            } else {
                SkeletonRows(count: 4, label: "Reading the update").listRowInsets(EdgeInsets())
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Update \(scope.name)")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(saving)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Not now") { dismiss() }.disabled(saving)
            }
            ToolbarItem(placement: .confirmationAction) {
                if saving { ProgressView() } else {
                    Button("Update to \(answer?.offer?.version ?? version)") { confirming = answer?.offer }
                        .disabled(answer?.offer == nil)
                        .accessibilityIdentifier("spade.template.update")
                }
            }
        }
        .confirmationDialog(confirming.map { "Update \(scope.name) to \($0.version)?" } ?? "",
                            isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
                            titleVisibility: .visible, presenting: confirming) { offer in
            Button("Update") { take(offer) }
        } message: { _ in
            Text("What it asks for more starts off until you turn it on in its Security section.")
        }
        .presentationDetents([.medium, .large])
        .task { await load() }
    }

    @ViewBuilder private func lines(_ title: String, _ items: [String]) -> some View {
        if !items.isEmpty {
            Section(title) {
                ForEach(items, id: \.self) { Text($0).aceFont(AceDesign.TextRole.message) }
            }
        }
    }

    private func load() async {
        answer = await scope.client.spadeTemplateOffer(scope.agent)
    }

    private func take(_ offer: SpadeTemplateOffer) {
        guard !saving else { return }
        saving = true
        problem = nil
        Task {
            let outcome = await scope.client.spadeTakeTemplate(scope.agent, offer)
            saving = false
            guard outcome.ok else { problem = outcome.problem; return }
            await updated()
            dismiss()
        }
    }
}
