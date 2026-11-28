import SwiftUI

/// A one-line row, as the web draws a chat and a snoozed or settled thread (`ThreadRow` with
/// `lead: "provider"`): the provider's mark, the title, then at the right edge one thing. A
/// chat ends with its status mark (`.status`); a snoozed or settled thread ends with its work,
/// the pull request and lines changed (`.work`), unless it needs the person or failed, when its
/// status mark stands there instead, or its work moved, when where it went does. A row still
/// syncing says Syncing there instead of any of these. Every line is the same height, so the
/// list stays combed.
struct InboxLineRow: View {
    enum End { case status, work }
    let row: ThreadRow
    let end: End
    /// At rest, the title in subtle ink and the mark quiet: a settled chat's. Settled threads keep
    /// full ink, as on the web: Settled is its own tab.
    var dimmed = false
    /// When a snoozed row wakes ("Until Thu 12:01 AM"), shown where it has no work to show. The
    /// web's hover card says it; a phone has no hover, so the line does.
    var wake: String? = nil

    var body: some View {
        let look = InboxThreadRow.look(of: row)
        HStack(spacing: AceDesign.Space.row) {
            // One width with or without the account's bubble, so every title starts in line.
            ProviderMark(provider: row.provider, size: AceDesign.Size.rowMark, account: row.account, quiet: dimmed)
                .foregroundStyle(AceTheme.Colours.foreground)
                .opacity(dimmed ? 1 : AceDesign.Ink.markOpacity)
                .frame(width: AceDesign.Size.rowLineLead, alignment: .leading)
            Text(row.title)
                .aceFont(InboxRowType.title, relativeTo: .callout)
                // Attention is brightness alone, never weight: what needs the person reads in full ink.
                .foregroundStyle(dimmed && look.level != "needs-you" ? AceTheme.Colours.subtleForeground : AceTheme.Colours.foreground)
                .lineLimit(1)
            Spacer(minLength: AceDesign.Space.related)
            trailing(look).fixedSize()
        }
        .padding(.horizontal, AceDesign.Size.rowInset)
        .frame(minHeight: AceDesign.Size.tap)
        .contentShape(Rectangle())
    }

    /// The one thing at the row's right edge.
    enum Trailing: Equatable { case syncing, moved, work, wake(String), mark(String), nothing }
    /// A row still syncing says so before anything else: its work, its wake time and where it
    /// moved all come from the copy it hasn't confirmed yet.
    static func trailing(_ look: RowLook, row: ThreadRow, end: End, wake: String?, dimmed: Bool) -> Trailing {
        if look.level == "syncing" { return .syncing }
        let urgent = look.level == "needs-you" || look.level == "failed"
        if end == .work && !urgent {
            // Its work went to another machine: where it went stands here, never its work or wake.
            if look.moved != nil { return .moved }
            if row.pr != nil || row.work != nil { return .work }
            return wake.map(Trailing.wake) ?? .nothing
        }
        if let icon = look.icon, icon != "none", marks(look, dimmed: dimmed) { return .mark(icon) }
        return .nothing
    }

    @ViewBuilder private func trailing(_ look: RowLook) -> some View {
        switch Self.trailing(look, row: row, end: end, wake: wake, dimmed: dimmed) {
        case .syncing:
            InboxRowAge(row: row, look: look)
        case .moved:
            HStack(spacing: AceDesign.Space.tight) {
                InboxRowMark(look: look, size: AceDesign.Size.rowStatus)
                InboxRowAge(row: row, look: look)
            }
        case .work:
            InboxLineWork(row: row)
        case .wake(let wake):
            HStack(spacing: AceDesign.Space.tight) {
                AceIcon(.clock, size: AceDesign.Size.rowPin, relativeTo: .caption)
                Text(wake).lineLimit(1)
            }
            .aceFont(AceDesign.TextRole.time, relativeTo: .caption)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
        case .mark(let icon):
            RowStatusIcon(kind: icon, tone: look.iconTone ?? "idle", count: look.count)
        case .nothing:
            EmptyView()
        }
    }

    /// Whether the row's one mark shows: a request, a failure, unseen finished work, or work
    /// still under way. A dimmed (settled) chat keeps its mark only while it is unread or urgent.
    static func marks(_ look: RowLook, dimmed: Bool) -> Bool {
        if ["needs-you", "failed"].contains(look.level) { return true }
        return !dimmed || look.unread == true
    }
}

/// A one-line row's work, as the web's `RowWork`: the pull request's glyph and number, then the
/// lines changed, all in muted ink.
private struct InboxLineWork: View {
    let row: ThreadRow
    var body: some View {
        HStack(spacing: AceDesign.Space.tight + 2) {
            if let pr = row.pr {
                HStack(spacing: AceTheme.Spacing.xxs) {
                    AceIcon(pr.state == "merged" ? .gitMerge : .gitPullRequest, size: AceDesign.Size.rowGlyph11, relativeTo: .caption2)
                    Text(verbatim: "#\(pr.number)")
                }
            }
            if let work = row.work { InboxRowWork(work: work) }
        }
        .aceFont(InboxRowType.line, relativeTo: .footnote)
        .monospacedDigit()
        .foregroundStyle(AceTheme.Colours.mutedForeground)
    }
}
