import SwiftUI

/// A pull request or issue page pushed on the second tab's stack (`InboxRoute.forge`).
struct ForgeRoute: Hashable {
    /// A pull request or issue page, a pull request's Timeline, its commits, or one of its
    /// changed files; or one of its checks, its merge conflicts or its stack.
    enum Kind: String { case pull, issue, timeline, files, file, commits, check, conflicts, stack }
    let kind: Kind
    let machineId: String
    let project: String
    let number: Int
    /// The changed file a `file` page shows, and where it sits in the pull request's list.
    var path: String?
    var index: Int?
    /// Another repository than the project's own (a notification's), named in every read.
    var repository: ForgeRepository?
    /// The check a `check` page shows (`ForgeCheck.id`).
    var checkId: String?
    /// The commits Files changed and a file show; nil for All commits.
    var range: ForgeRange?
}

/// One pull request, in the thread row's shape (`InboxThreadRow`): its state glyph beside the
/// title and its age, then one quiet line with the number, the author and its next step (only the
/// viewer's steps take the needs-you colour), or what it waits on. Review and checks are two
/// small marks at the end. Labels, comments, line counts and branches live on its page.
struct ForgePullRowView: View {
    let row: ForgePullRow

    var body: some View {
        ForgeRowLayout(title: row.title, updatedAt: row.updatedAt) {
            ForgePullGlyph(state: row.state, merged: row.merged, conflicting: row.conflicting, size: 15)
        } line: {
            ForgeRowLine(number: row.number, author: row.author, step: row.step, needsYou: row.stepNeedsYou,
                         quiet: row.quiet, thread: row.thread)
        } marks: {
            if let review = row.review { ForgeStateMark(kind: .review, mark: review) }
            if let checks = row.checks { ForgeStateMark(kind: .checks, mark: checks) }
        }
    }
}

/// One issue, in the same shape: glyph, title and age, then the number, the author and its
/// milestone.
struct ForgeIssueRowView: View {
    let row: ForgeIssueRow

    var body: some View {
        ForgeRowLayout(title: row.title, updatedAt: row.updatedAt) {
            ForgeIssueGlyph(state: row.state, size: 15)
        } line: {
            ForgeRowLine(number: row.number, author: row.author, step: nil, needsYou: false, quiet: row.milestone, thread: row.thread)
        } marks: {
            EmptyView()
        }
    }
}

/// A forge row laid out as a thread row: the glyph in the mark column, the title (heavier while
/// open) with its age, and the line under it ending in its marks.
private struct ForgeRowLayout<Glyph: View, Line: View, Marks: View>: View {
    let title: String
    let updatedAt: Double?
    @ViewBuilder let glyph: () -> Glyph
    @ViewBuilder let line: () -> Line
    @ViewBuilder let marks: () -> Marks
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.md) {
            glyph().alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
                    Text(title)
                        .aceFont(InboxRowType.title, relativeTo: .body)
                        .openRowTitle()
                        .foregroundStyle(AceTheme.Colours.foreground)
                        .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                    Spacer(minLength: AceTheme.Spacing.sm)
                    if let updatedAt { ForgeRowAge(updatedAt: updatedAt) }
                }
                HStack(alignment: .center, spacing: AceTheme.Spacing.xs) {
                    line()
                    Spacer(minLength: AceTheme.Spacing.sm)
                    HStack(spacing: AceTheme.Spacing.sm) { marks() }.fixedSize().layoutPriority(2)
                }
                .aceFont(InboxRowType.line, relativeTo: .subheadline)
            }
        }
        .padding(.horizontal, AceTheme.Spacing.md)
        .padding(.vertical, AceTheme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// "#412 · arpan · Review requested": the number, the author, then the step (or what it waits
/// on). A linked thread that needs the person says so in its place when nothing else does.
private struct ForgeRowLine: View {
    let number: Int
    let author: String
    let step: String?
    let needsYou: Bool
    let quiet: String?
    let thread: ForgeThreadLink?

    var body: some View {
        Text(verbatim: "#\(number)").monospacedDigit().foregroundStyle(AceTheme.Colours.subtleForeground).fixedSize()
        Text("· \(author)").foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1).layoutPriority(-1)
        if let step {
            Text("· \(step)")
                .fontWeight(needsYou ? .medium : .regular)
                .foregroundStyle(needsYou ? AceTone.needsYou.text : AceTheme.Colours.mutedForeground)
                .lineLimit(1).layoutPriority(1)
        } else if let thread, thread.needsYou {
            Text("· \(thread.title)").fontWeight(.medium).foregroundStyle(AceTone.needsYou.text).lineLimit(1)
                .accessibilityLabel("Thread \(thread.title), needs you")
        } else if let quiet, !quiet.isEmpty {
            Text("· \(quiet)").foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
        }
    }
}

/// The row's age, as the thread rows set theirs.
private struct ForgeRowAge: View {
    let updatedAt: Double
    var body: some View {
        TimelineView(.everyMinute) { context in
            Text(ActivityTime.age(since: Date(timeIntervalSince1970: updatedAt / 1000), now: context.date))
                .monospacedDigit()
                .aceFont(InboxRowType.line, relativeTo: .subheadline)
                .foregroundStyle(AceTheme.Colours.subtleForeground)
                .lineLimit(1).fixedSize()
        }
    }
}
