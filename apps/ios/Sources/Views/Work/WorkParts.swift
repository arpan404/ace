import SwiftUI

/// The top of Work: the project in the header role, then where it runs ("arpan-mbp · Worktree")
/// and the folder in mono. It says where the checkout is before any section does.
struct WorkHeader: View {
    let work: WorkSummary
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            Text(work.project.isEmpty ? "Checkout" : work.project)
                .aceFont(AceDesign.TextRole.header, relativeTo: .headline)
                .foregroundStyle(AceDesign.Ink.primary).lineLimit(1)
            Text([work.machine.isEmpty ? "This machine" : work.machine, place].filter { !$0.isEmpty }.joined(separator: " · "))
                .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                .foregroundStyle(AceDesign.Ink.muted).lineLimit(1)
            if !work.path.isEmpty {
                Text(verbatim: work.path).aceMonospace(AceDesign.TextRole.code, relativeTo: .caption)
                    .foregroundStyle(AceDesign.Ink.subtle).lineLimit(1).truncationMode(.middle)
                    .textSelection(.enabled)
            }
        }
        .padding(.horizontal, AceDesign.Space.margin)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("work.header")
    }
    /// What kind of place it is, once the checkout has been read.
    private var place: String {
        if work.chat { return "A chat's folder" }
        switch work.state {
        case "ready": return work.mode == "worktree" ? "Worktree" : "Local checkout"
        case "none": return "Not a git checkout"
        case "loading": return "Reading the checkout"
        default: return ""
        }
    }
}

/// Local or a worktree as one row: its name, why it can't be chosen now, and "Current" or the
/// word that moves the thread there.
struct WorkPlaceRow: View {
    let label: String
    let current: Bool
    let reason: String?
    let mode: String
    let canMove: Bool
    let enabled: Bool
    let move: () -> Void
    var body: some View {
        QuietSectionRow {
            QuietRowText(title: label, detail: current ? nil : reason)
            if current {
                Text("Current").aceFont(AceDesign.TextRole.action, relativeTo: .subheadline).foregroundStyle(AceDesign.Ink.subtle)
            } else if canMove, reason == nil {
                Button("Move here", action: move)
                    .buttonStyle(.textAction(.prominent))
                    .disabled(!enabled)
                    .accessibilityLabel(mode == "worktree" ? "Move to worktree" : "Move to local")
                    .accessibilityIdentifier("work.move.\(mode)")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("work.place.\(mode)")
    }
}

/// "#214 Fix the queue" over "Open · checks passed · owner/name".
struct WorkPullLine: View {
    let pr: WorkSummary.PullRequest
    var body: some View {
        HStack(spacing: AceDesign.Space.row) {
            AceIcon(pr.state == "merged" ? .gitMerge : .gitPullRequest, size: AceDesign.Size.icon, relativeTo: .subheadline)
                .foregroundStyle(AceDesign.Ink.subtle)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                (Text("#\(pr.number) ").monospacedDigit().foregroundStyle(AceDesign.Ink.muted)
                 + Text(pr.title.isEmpty ? "Pull request" : pr.title).foregroundStyle(AceDesign.Ink.primary))
                    .aceFont(AceDesign.TextRole.rowTitle, relativeTo: .callout)
                    .lineLimit(1)
                Text([pr.summary, pr.repo].filter { !$0.isEmpty }.joined(separator: " · "))
                    .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                    .foregroundStyle(AceDesign.Ink.muted).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minHeight: AceDesign.Size.tap)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("work.pr.\(pr.number)")
    }
}

/// What stops the checkout, as the one status sentence: the label in the failed colour (a skipped
/// setup stays quiet), why, a failed setup's last output lines in mono, and its ways out as words.
struct WorkProblemRows: View {
    let problem: WorkSummary.Problem
    let canAct: Bool
    let run: (WorkAction) -> Void
    var body: some View {
        WorkStatus(label: problem.label, detail: problem.detail, failed: problem.failed, output: problem.output) {
            if canAct {
                ForEach(Array(problem.actions.enumerated()), id: \.element.id) { index, action in
                    Button(action.label) { run(action) }
                        .buttonStyle(.textAction(action.destructive ? .destructive : index == 0 ? .prominent : .plain))
                        .accessibilityIdentifier("work.problem.\(action.id)")
                }
            }
        }
        .accessibilityIdentifier("work.problem")
    }
}

/// A status at the top of Work: one sentence, at most a line of why, output when there is some,
/// then its actions as words in one row. No box, no tint: the sentence's colour is the state.
struct WorkStatus<Actions: View>: View {
    let label: String
    var detail = ""
    var failed = true
    var output: [String] = []
    @ViewBuilder var actions: () -> Actions
    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            Text(label).aceFont(AceDesign.TextRole.rowTitle, relativeTo: .callout)
                .foregroundStyle(failed ? AceTheme.StatusText.failed : AceDesign.Ink.primary)
            if !detail.isEmpty {
                Text(detail).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                    .foregroundStyle(AceDesign.Ink.muted).fixedSize(horizontal: false, vertical: true)
            }
            if !output.isEmpty {
                ScrollView {
                    Text(verbatim: output.joined(separator: "\n"))
                        .aceMonospace(AceDesign.TextRole.code, relativeTo: .caption)
                        .foregroundStyle(AceDesign.Ink.subtle)
                        .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                }
                .frame(maxHeight: AceDesign.Size.outputMaxHeight).fixedSize(horizontal: false, vertical: true)
                .padding(.top, AceDesign.Space.tight)
                .accessibilityLabel("Setup output")
            }
            HStack(spacing: AceDesign.Space.margin) { actions() }
        }
        .padding(.horizontal, AceDesign.Space.margin)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }
}

/// The sheet's shape while the bridge reads it, so nothing jumps when the rows arrive.
struct WorkSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.group) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text("ace-next").aceFont(AceDesign.TextRole.header, relativeTo: .headline)
                Text("This machine · Local checkout").aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
            }
            .padding(.horizontal, AceDesign.Space.margin)
            ForEach(["Branch", "Checkout", "Pull requests"], id: \.self) { title in
                QuietSection(title) {
                    QuietSectionRow { QuietRowText(title: "Reading the checkout") }
                    QuietSectionRow { QuietRowText(title: "main") }
                }
            }
        }
        .redacted(reason: .placeholder)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Reading the checkout")
    }
}
