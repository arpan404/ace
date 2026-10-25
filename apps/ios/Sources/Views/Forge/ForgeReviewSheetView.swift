import SwiftUI

/// Finish your review: a summary, Comment / Approve / Request changes (each off with GitHub's
/// reason where it can't be given), the pending line comments each removable, and Submit review,
/// which sends them all as one review at the head the page showed.
struct ForgeReviewSheetView: View {
    let sheet: ForgeReviewSheet
    let desk: ForgeReviewDesk
    @AppStorage private var summary: String
    @State private var verdict = "COMMENT"
    @Environment(\.dismiss) private var dismiss

    init(sheet: ForgeReviewSheet, desk: ForgeReviewDesk) {
        self.sheet = sheet
        self.desk = desk
        // The summary is kept on this phone until it is sent, as the web keeps its draft.
        let target = desk.target
        _summary = AppStorage(wrappedValue: "", "ace.forge.review.\(target.repository.owner)/\(target.repository.name)#\(target.number)")
    }

    private var chosen: String { sheet.verdicts.first { $0.event == verdict && !$0.off } != nil ? verdict : "COMMENT" }
    private var empty: Bool { chosen != "APPROVE" && summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && sheet.drafts.isEmpty }
    private var blocked: Bool { empty || sheet.refused != nil || sheet.stale != nil || !desk.ready }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.lg) {
                    ForgeEditor(text: $summary, placeholder: "Leave a summary", minLines: 3, completer: desk.completer)
                        .disabled(sheet.refused != nil)
                        .padding(.horizontal, AceTheme.Spacing.lg)
                    Picker("Verdict", selection: $verdict) {
                        ForEach(sheet.verdicts, id: \.event) { verdict in
                            Text(verdict.label).tag(verdict.event).selectionDisabled(verdict.off)
                        }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, AceTheme.Spacing.lg)
                    .accessibilityIdentifier("forge.review.verdict")
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                        ForEach([sheet.blocked, sheet.refused, sheet.stale].compactMap { $0 }, id: \.self) { Text($0).meta().lineLimit(3) }
                        if let message = desk.message {
                            Text(message).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTone.failed.text)
                        }
                    }
                    .padding(.horizontal, AceTheme.Spacing.lg)
                    if !sheet.drafts.isEmpty {
                        ForgeSection(title: sheet.drafts.count == 1 ? "1 pending comment" : "\(sheet.drafts.count) pending comments") {
                            ForEach(sheet.drafts) { draft in draftRow(draft) }
                        }
                    }
                }
                .padding(.vertical, AceTheme.Spacing.md)
            }
            .background(AceTheme.Colours.background)
            .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) {
                Button { submit() } label: {
                    HStack {
                        if desk.writing { ProgressView().controlSize(.small) }
                        Text("Submit review").fontWeight(.semibold)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent).buttonBorderShape(.capsule)
                .tint(AceTheme.Colours.foreground).foregroundStyle(AceTheme.Colours.background)
                .disabled(blocked)
                .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.sm)
                .background(AceTheme.Colours.background)
                .accessibilityIdentifier("forge.review.submit")
            }
            .navigationTitle("Finish your review")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .onAppear { desk.clearMessage() }
        .presentationDetents([.medium, .large])
    }

    private func draftRow(_ draft: ForgeReviewSheet.Draft) -> some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                HStack(spacing: AceTheme.Spacing.xs) {
                    Text(draft.place).aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.subtleForeground).lineLimit(1).truncationMode(.head)
                    if draft.outdated { Text("Outdated").meta(AceTone.needsYou.text) }
                }
                Text(draft.body).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                    .foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
            }
            Spacer(minLength: AceTheme.Spacing.sm)
            Button("Remove") { Task { await desk.run(["kind": "draft.delete", "id": draft.id]) } }
                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                .disabled(!desk.ready)
        }
        .padding(.horizontal, AceTheme.Spacing.lg)
        .frame(minHeight: 48)
    }

    private func submit() {
        let body = summary
        let action: [String: Any] = ["kind": "submit", "event": chosen, "body": body, "headSha": sheet.headSha, "draftIds": sheet.drafts.map(\.id)]
        Task {
            guard await desk.run(action) else { return }
            if summary == body { summary = "" }
            dismiss()
        }
    }
}
