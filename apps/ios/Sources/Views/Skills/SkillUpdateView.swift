import SwiftUI

/// Source, for a skill installed from a repository: where it came from and when it was updated,
/// a check for a newer version, then Review update, which opens what that version changes.
/// Nothing changes on the machine until Update in the review.
struct SkillSourceRow: View {
    let model: ClientModel
    let page: SkillPage
    let source: String
    let workspaceId: String?
    let updated: (SkillUpdateApplied) -> Void
    @State private var check: SkillUpdateCheck?
    @State private var checking = false
    @State private var reviewing = false
    @State private var problem: String?

    var body: some View {
        QuietSectionRow {
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                QuietRowText(title: "Source", detail: check.map { "\(source) · \($0.status)" } ?? source)
                if let problem {
                    Text(problem).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.StatusText.failed)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("skill.update.problem")
                }
            }
            if model.canOperate {
                if check?.available == true {
                    Button("Review update") { reviewing = true }
                        .buttonStyle(.textAction(.prominent))
                        .accessibilityIdentifier("skill.update.review")
                } else {
                    Button(checking ? "Checking…" : "Check for update") { Task { await runCheck() } }
                        .buttonStyle(.textAction(.prominent))
                        .disabled(checking)
                        .accessibilityIdentifier("skill.update.check")
                }
            }
        }
        // A check answers for the folder it looked at; an update or an edit since asks again.
        .onChange(of: page.hash) { check = nil }
        .sheet(isPresented: $reviewing) {
            SkillUpdateReviewView(model: model, skillId: page.id, title: page.title, workspaceId: workspaceId) { applied in
                check = nil
                updated(applied)
            }
        }
    }

    private func runCheck() async {
        checking = true; problem = nil
        defer { checking = false }
        do {
            var operation: [String: Any] = ["op": "checkUpdate", "id": page.id]
            if let workspaceId { operation["workspaceId"] = workspaceId }
            check = try await model.skills(operation, as: SkillUpdateCheck.self)
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}

/// What a skill's update changes before it is applied: each file it adds, changes or removes
/// (marking those agents could run), then SKILL.md line by line, then Update. Closing without
/// updating lets the review go. Cardless, as the design language's inner pages.
struct SkillUpdateReviewView: View {
    let model: ClientModel
    let skillId: String
    let title: String
    let workspaceId: String?
    let applied: (SkillUpdateApplied) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var review: SkillUpdateReview?
    @State private var busy = false
    @State private var done = false
    @State private var problem: String?
    /// The last Update didn't hear back: the next one says so, and one already applied counts.
    @State private var uncertain = false

    private var at: [String: Any] { workspaceId.map { ["workspaceId": $0] } ?? [:] }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                    if let review {
                        Text(review.summary).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                            .foregroundStyle(AceDesign.Ink.muted)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.horizontal, AceDesign.Space.margin)
                        files(review)
                        skillFile(review)
                    } else if problem == nil {
                        SkeletonRows(count: 4, label: "Fetching the update")
                    }
                    if let problem { QuietProblem(message: problem, id: "skill.update.review.problem") }
                    if review != nil {
                        Button(busy ? "Updating…" : "Update") { Task { await apply() } }
                            .buttonStyle(.textAction(.prominent))
                            .disabled(busy || !model.canOperate)
                            .padding(.horizontal, AceDesign.Space.margin)
                            .accessibilityIdentifier("skill.update.apply")
                        Text("Update replaces the skill's files with exactly the version shown here.")
                            .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                            .foregroundStyle(AceDesign.Ink.muted)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.horizontal, AceDesign.Space.margin)
                    }
                }
                .padding(.top, AceDesign.Space.related).padding(.bottom, AceDesign.Space.group)
                .animation(.default, value: review)
            }
            .background(AceDesign.Surface.background)
            .navigationTitle(review?.title ?? "Update \(title)").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) } }
        }
        .interactiveDismissDisabled(busy)
        .task { await prepare() }
        .onDisappear {
            if let review, !done { Task { _ = try? await model.skills(["op": "cancelUpdate", "reviewId": review.id], as: ServiceValue.self) } }
        }
    }

    /// Each file the update touches: its path in mono, whether agents may run it, and how it changes.
    private func files(_ review: SkillUpdateReview) -> some View {
        QuietSection("Files") {
            ForEach(review.files, id: \.path) { file in
                QuietSectionRow {
                    Text(verbatim: file.path).aceMonospace(AceDesign.TextRole.code, relativeTo: .caption)
                        .foregroundStyle(AceDesign.Ink.primary)
                        .lineLimit(1).truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let runnable = file.runnable {
                        Text(runnable).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                            .fontWeight(AceDesign.Typeface.strong)
                            .foregroundStyle(AceDesign.Ink.primary).lineLimit(1)
                    }
                    Text(file.change).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                        .foregroundStyle(AceDesign.Ink.muted).lineLimit(1)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    /// SKILL.md before and after, line by line; unchanged runs fold to a count.
    private func skillFile(_ review: SkillUpdateReview) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            HStack(spacing: AceDesign.Space.related) {
                QuietHeading("SKILL.md")
                Spacer(minLength: AceDesign.Space.related)
                Text(verbatim: "+\(review.diff.additions) −\(review.diff.deletions)")
                    .aceMonospace(AceDesign.TextRole.code, relativeTo: .caption)
                    .foregroundStyle(AceDesign.Ink.subtle)
                    .accessibilityLabel("\(review.diff.additions) lines added, \(review.diff.deletions) removed")
            }
            .padding(.horizontal, AceDesign.Space.margin).padding(.bottom, AceDesign.Space.tight)
            LazyVStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                ForEach(Array(review.diff.rows.enumerated()), id: \.offset) { _, line in
                    SkillUpdateDiffLine(line: line)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func prepare() async {
        do {
            // The machine fetches the skill's repository first, which can be slow: wait as long
            // as the bridge does (`bridge/skill-update.ts`), not the usual 30 seconds.
            review = try await model.skills(["op": "prepareUpdate", "id": skillId].merging(at) { $1 }, as: SkillUpdatePrepared.self,
                                            timeout: .seconds(300)).review
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
    private func apply() async {
        guard let review, !busy else { return }
        busy = true; problem = nil
        defer { busy = false }
        do {
            let reply = try await model.skills(["op": "applyUpdate", "id": skillId, "reviewId": review.id, "expectedHash": review.baseHash,
                                                "folderHash": review.folderHash, "retry": uncertain].merging(at) { $1 },
                                               as: SkillUpdateApplied.self)
            done = true
            dismiss()
            applied(reply)
        } catch let failure as SkillFailure {
            uncertain = failure.uncertain
            problem = failure.message
        } catch { problem = error.localizedDescription }
    }
}

/// One line of SKILL.md's diff in SF Mono: its number, a bar in the change's colour, the text
/// wrapped under itself. Colour marks only additions and deletions.
private struct SkillUpdateDiffLine: View {
    let line: SkillUpdateReview.Line
    var body: some View {
        if line.kind == "fold" {
            Text(line.text).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                .foregroundStyle(AceDesign.Ink.subtle)
                .padding(.leading, FileDiffStyle.gutter)
                .frame(maxWidth: .infinity, minHeight: FileDiffStyle.rowHeight, alignment: .leading)
        } else {
            HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.none) {
                Text(verbatim: line.number.map(String.init) ?? "").foregroundStyle(bar ?? AceTheme.Colours.decoration)
                    .frame(width: FileDiffStyle.gutter - AceTheme.Spacing.md, alignment: .trailing)
                    .padding(.trailing, AceTheme.Spacing.md)
                Text(verbatim: line.text).foregroundStyle(AceTheme.Colours.foreground)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.trailing, AceTheme.Spacing.lg)
            }
            .aceMonospace(FileDiffStyle.line, relativeTo: .caption)
            .frame(maxWidth: .infinity, minHeight: FileDiffStyle.rowHeight, alignment: .leading)
            .background(background)
            .overlay(alignment: .leading) {
                if let bar { Rectangle().fill(bar).frame(width: FileDiffStyle.bar) }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(line.kind == "add" ? "Added" : line.kind == "del" ? "Removed" : "Unchanged") line \(line.number ?? 0): \(line.text)")
        }
    }
    private var bar: Color? {
        line.kind == "add" ? AceTheme.StatusText.done : line.kind == "del" ? AceTheme.StatusText.failed : nil
    }
    private var background: Color {
        line.kind == "add" ? AceTheme.Colours.diffAdd : line.kind == "del" ? AceTheme.Colours.diffDelete : .clear
    }
}
