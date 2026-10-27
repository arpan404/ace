import SwiftUI

/// What a long press on a row shows above its menu, as the web's hover card does: the title and
/// the row's own status words, then one fact a line (project, machine, branch, provider and
/// model with running subagents), and the work it holds (pull request, lines changed). Read from
/// the row alone: no history is fetched. Tapping the row stays the way in.
struct ThreadPreview: View {
    let row: ThreadRow
    let machine: MachineMark?
    let project: ProjectMarkLook?

    private var look: RowLook {
        row.look ?? RowLook(level: "quiet", word: row.status.label, tone: row.status.token, muted: true,
                            glyph: nil, since: nil, settled: false, subagents: max(0, row.agents - 1))
    }

    var body: some View {
        let look = look
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(row.title).aceFont(InboxRowType.title, relativeTo: .body).fontWeight(.medium)
                    .foregroundStyle(AceTheme.Colours.foreground).lineLimit(3)
                // The row's own status, so the preview and the row never word it differently.
                StateLabel(status: row.status).aceFont(InboxRowType.line, relativeTo: .subheadline)
            }
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                if !row.project.isEmpty {
                    fact { ProjectMark(initials: row.badge ?? "", chat: row.chat == true, look: project) } text: { row.project }
                }
                if let machine, !row.machine.isEmpty {
                    fact { AceIcon(machine.glyph, size: 14, relativeTo: .subheadline) } text: { row.machine }
                }
                if !row.branch.isEmpty {
                    fact { AceIcon(.gitBranch, size: 14, relativeTo: .subheadline) } text: { row.branch }
                        .monospaced()
                }
                HStack(spacing: AceTheme.Spacing.sm) {
                    ProviderMark(provider: row.provider, size: 14, account: row.account)
                    Text(row.model.isEmpty ? row.provider.capitalized : row.model).lineLimit(1)
                    Spacer(minLength: AceTheme.Spacing.sm)
                    if look.subagents > 0 {
                        HStack(spacing: AceTheme.Spacing.xxs) {
                            AceIcon(.treeStructure, size: 14, relativeTo: .subheadline)
                            Text(look.subagents.formatted()).monospacedDigit()
                        }
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("\(look.subagents) \(look.subagents == 1 ? "subagent" : "subagents") running")
                    }
                }
            }
            .aceFont(InboxRowType.line, relativeTo: .subheadline)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            if row.pr != nil || row.diff != nil {
                Divider()
                HStack(spacing: AceTheme.Spacing.md) {
                    if let pr = row.pr {
                        HStack(spacing: AceTheme.Spacing.xs) {
                            AceIcon(.gitPullRequest, size: 14, relativeTo: .subheadline)
                            Text("#\(pr.number)").monospacedDigit()
                            Text(pr.state.capitalized)
                        }
                    }
                    if let diff = row.diff {
                        HStack(spacing: AceTheme.Spacing.xs) {
                            Text("+\(diff.additions)").foregroundStyle(AceTheme.Colours.diffAdd)
                            Text("−\(diff.deletions)").foregroundStyle(AceTheme.Colours.diffDelete)
                        }
                        .monospacedDigit()
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("\(diff.additions) lines added, \(diff.deletions) lines removed")
                    }
                    Spacer(minLength: AceTheme.Spacing.none)
                }
                .aceFont(InboxRowType.line, relativeTo: .subheadline)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
            }
        }
        .padding(AceTheme.Spacing.lg)
        .frame(width: 320, alignment: .leading)
        .background(AceTheme.Colours.background)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("thread.preview")
    }

    private func fact<Mark: View>(@ViewBuilder _ mark: () -> Mark, text: () -> String) -> some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            mark().frame(minWidth: 20)
            Text(text()).lineLimit(1).truncationMode(.middle)
        }
    }
}
