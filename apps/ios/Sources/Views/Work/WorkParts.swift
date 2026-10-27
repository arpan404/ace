import SwiftUI

/// A heading over one hairline, then plain rows with no lines between them.
struct WorkSection<Rows: View>: View {
    let title: String
    @ViewBuilder let rows: () -> Rows
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            Text(title).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).fontWeight(.medium)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .padding(.horizontal, AceTheme.Spacing.lg).padding(.bottom, AceTheme.Spacing.xs)
                .accessibilityAddTraits(.isHeader)
            Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border)
            rows()
        }
    }
}

/// One row: what, then its value at the end. `failed` is the one loud state.
struct WorkRow: View {
    let label: String
    var value = ""
    var mono = false
    var quiet = false
    var failed = false
    var disclosure = false
    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            Group {
                if mono { Text(verbatim: label).aceMonospace(AceTheme.Typography.label, relativeTo: .body) } else { Text(label) }
            }
            .lineLimit(1).truncationMode(.middle)
            .foregroundStyle(failed ? AceTheme.StatusText.failed : quiet ? AceTheme.Colours.mutedForeground : AceTheme.Colours.foreground)
            Spacer(minLength: AceTheme.Spacing.sm)
            if !value.isEmpty { Text(value).lineLimit(2).multilineTextAlignment(.trailing).foregroundStyle(AceTheme.Colours.mutedForeground) }
            if disclosure { Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(AceTheme.Colours.subtleForeground) }
        }
        .aceFont(AceTheme.Typography.label, relativeTo: .body)
        .padding(.horizontal, AceTheme.Spacing.lg)
        .frame(minHeight: AceTheme.Dimensions.touchTarget)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// "#214 Fix the queue" over "open · checks passed · owner/name".
struct WorkPullLine: View {
    let pr: WorkSummary.PullRequest
    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            AceIcon(pr.state == "merged" ? .gitMerge : .gitPullRequest, size: 16, relativeTo: .body)
                .foregroundStyle(AceTheme.Colours.subtleForeground)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                (Text("#\(pr.number) ").monospacedDigit().foregroundStyle(AceTheme.Colours.mutedForeground)
                 + Text(pr.title.isEmpty ? "Pull request" : pr.title).foregroundStyle(AceTheme.Colours.foreground))
                    .lineLimit(1)
                Text("\(pr.summary) · \(pr.repo)").aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
            }
            Spacer(minLength: AceTheme.Spacing.sm)
        }
        .aceFont(AceTheme.Typography.label, relativeTo: .body)
        .frame(minHeight: AceTheme.Dimensions.touchTarget)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("work.pr.\(pr.number)")
    }
}

/// A checkout problem: its label in the failed colour (a skipped setup stays quiet), why, a failed
/// setup's last output lines, and its ways out as words.
struct WorkProblemRows: View {
    let problem: WorkSummary.Problem
    let canAct: Bool
    let run: (WorkAction) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            WorkRow(label: problem.label, failed: problem.failed)
            if !problem.detail.isEmpty {
                Text(problem.detail).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).padding(.horizontal, AceTheme.Spacing.lg)
            }
            if !problem.output.isEmpty {
                ScrollView {
                    Text(verbatim: problem.output.joined(separator: "\n"))
                        .aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                        .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                }
                .frame(maxHeight: 160).fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.xs)
                .accessibilityLabel("Setup output")
            }
            if canAct, !problem.actions.isEmpty {
                HStack(spacing: AceTheme.Spacing.xs) {
                    ForEach(problem.actions) { action in
                        WorkWordButton(label: action.label, destructive: action.destructive, identifier: "work.problem.\(action.id)") { run(action) }
                    }
                }
                .padding(.horizontal, AceTheme.Spacing.sm)
            }
        }
        .accessibilityIdentifier("work.problem")
    }
}

/// The sheet's shape while the bridge reads it, so nothing jumps when the rows arrive.
struct WorkSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxl) {
            ForEach(["Checkout", "Branch", "Pull requests"], id: \.self) { title in
                WorkSection(title: title) {
                    WorkRow(label: "Reading the checkout", value: "local")
                    WorkRow(label: "main")
                }
            }
        }
        .redacted(reason: .placeholder)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Reading the checkout")
    }
}
