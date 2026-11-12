import SwiftUI

/// Bring back to parent: a summary of the fork's work, its newest answer to start with, sent to
/// the thread it was forked from, whose agent reads it on its next turn. The fork stays.
struct MergeSheet: View {
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
                VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                    Text("Send a summary to \(parentTitle). Its agent reads it on the next turn. This fork stays available.")
                        .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                        .foregroundStyle(AceDesign.Ink.muted)
                        .padding(.horizontal, AceDesign.Space.margin)
                    if let waits = screen.mergeDraft?.waits, !waits.isEmpty {
                        Text(waits)
                            .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                            .foregroundStyle(AceDesign.Ink.muted)
                            .padding(.horizontal, AceDesign.Space.margin)
                    }
                    if let problem {
                        Text(problem).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                            .foregroundStyle(AceTheme.StatusText.failed).accessibilityIdentifier("merge.problem")
                            .padding(.horizontal, AceDesign.Space.margin)
                    }
                    // The summary is the page: a quiet heading, the words on the page itself, a
                    // hairline under them. No filled box around the field.
                    VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                        InsetHeader("Summary").padding(.horizontal, AceDesign.Space.margin)
                        TextEditor(text: $summary)
                            .aceFont(AceDesign.TextRole.message, relativeTo: .body)
                            .foregroundStyle(AceDesign.Ink.primary)
                            .scrollContentBackground(.hidden)
                            .frame(minHeight: AceDesign.Size.tap * 5)
                            // The editor's own text inset, pulled back so its words start at the margin.
                            .padding(.horizontal, AceDesign.Space.margin - AceDesign.Space.tight)
                            .disabled(sending)
                            .accessibilityIdentifier("merge.summary")
                        Hairline().padding(.leading, AceDesign.Space.margin)
                    }
                    QuietSection {
                        QuietSectionRow {
                            Toggle(isOn: $includeCode) {
                                QuietRowText(title: "Include code changes",
                                             detail: "Uncommitted tracked changes only. Both threads must finish before they can be applied.")
                            }
                            .toggleStyle(.systemSwitch).disabled(sending)
                            .accessibilityIdentifier("merge.code")
                        }
                    }
                }
                .padding(.top, AceDesign.Space.related).padding(.bottom, AceDesign.Space.group)
            }
            .background(AceDesign.Surface.background)
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
        .task {
            while !Task.isCancelled {
                model.readMergeDraft()
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
            }
        }
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
