import SwiftUI

/// The branches the bridge read for the chosen project.
typealias NewThreadBranches = (state: String, bases: [ComposeBase], start: ComposeBaseRef?, noWorktree: String?)

/// The one slot tucked under the composer's top edge: where the thread runs ("machine · Worktree ☑
/// · ⑂ origin/main ⌄"), or, while something holds Send back, that notice instead.
struct NewThreadStrip: View {
    let drafts: NewThreadDraftModel
    let branches: NewThreadBranches?
    /// The machines to pick from, only when more than one is paired.
    let machines: [(id: String, name: String)]
    let machineId: String?
    let chooseMachine: (String) -> Void
    /// What holds Send back, and whether it failed rather than waits.
    let notice: (text: String, failed: Bool)?
    private var draft: NewThreadDraft { drafts.draft }
    private var worktree: Bool { draft.worktree && branches?.noWorktree == nil }

    var body: some View {
        if notice != nil || machines.count > 1 || draft.projectId != nil {
            HStack(spacing: AceTheme.Spacing.xs) {
                if let notice {
                    Text(notice.text)
                        .foregroundStyle(notice.failed ? AceTheme.StatusText.failed : AceTheme.Colours.mutedForeground)
                        .lineLimit(2)
                        .padding(.horizontal, AceTheme.Spacing.sm)
                        .accessibilityIdentifier("newThread.note")
                } else {
                    environment
                }
                Spacer(minLength: AceTheme.Spacing.none)
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            .padding(.horizontal, AceTheme.Spacing.xs)
            .frame(minHeight: 36)
            .aceGlass(in: UnevenRoundedRectangle(topLeadingRadius: AceTheme.Radii.code, topTrailingRadius: AceTheme.Radii.code))
            .padding(.horizontal, AceTheme.Spacing.lg)
        }
    }

    @ViewBuilder private var environment: some View {
        if machines.count > 1 {
            Menu {
                Picker("Machine", selection: Binding(get: { machineId ?? "" }, set: chooseMachine)) {
                    ForEach(machines, id: \.id) { Text($0.name).tag($0.id) }
                }
            } label: {
                segment {
                    Image(systemName: "laptopcomputer").foregroundStyle(AceTheme.Colours.subtleForeground)
                    Text(machines.first { $0.id == machineId }?.name ?? "").lineLimit(1)
                }
            }
            .accessibilityLabel("Machine").accessibilityValue(machines.first { $0.id == machineId }?.name ?? "")
            .accessibilityIdentifier("newThread.machine")
            if draft.projectId != nil { divider }
        }
        if draft.projectId != nil {
            Button { drafts.edit { $0.worktree.toggle() } } label: {
                segment {
                    Text("Worktree")
                    StripCheckbox(checked: worktree)
                }
            }
            .buttonStyle(.plain)
            .disabled(branches?.noWorktree != nil || branches?.state != "ready")
            .accessibilityLabel("Worktree")
            .accessibilityValue(worktree ? "On" : "Off")
            .accessibilityHint(branches?.noWorktree ?? "A branch and folder of its own; your checkout stays as it is")
            .accessibilityIdentifier("newThread.worktree")
            .sensoryFeedback(.selection, trigger: worktree)
            if worktree { divider; base }
        }
    }

    @ViewBuilder private var base: some View {
        if let branches, !branches.bases.isEmpty {
            let selected = draft.base ?? branches.start
            Menu {
                Picker("Starts from", selection: Binding<ComposeBaseRef?>(get: { selected }, set: { base in drafts.edit { $0.base = base } })) {
                    ForEach(branches.bases) { base in
                        let tag: ComposeBaseRef? = base.base
                        Text(base.title).tag(tag)
                    }
                }
            } label: {
                segment {
                    Image(systemName: "arrow.triangle.branch").foregroundStyle(AceTheme.Colours.subtleForeground)
                    Text(branches.bases.first { $0.base == selected }?.label ?? "Current branch")
                        .aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.foreground).lineLimit(1).truncationMode(.middle)
                    Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(AceTheme.Colours.subtleForeground)
                }
            }
            .accessibilityLabel("Starts from").accessibilityValue(branches.bases.first { $0.base == selected }?.label ?? "")
            .accessibilityIdentifier("newThread.base")
        } else if branches?.state != "failed" {
            segment {
                Image(systemName: "arrow.triangle.branch").foregroundStyle(AceTheme.Colours.subtleForeground)
                Capsule().fill(AceTheme.Colours.fill).frame(width: 72, height: 10)
            }
            .accessibilityLabel("Reading branches")
        }
    }

    private func segment<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: AceTheme.Spacing.xs + AceTheme.Spacing.xxs, content: content)
            .padding(.horizontal, AceTheme.Spacing.sm)
            .frame(minHeight: 36)
            .contentShape(Rectangle())
    }
    private var divider: some View {
        Rectangle().fill(AceTheme.Colours.separator).frame(width: AceTheme.Dimensions.border, height: 14).accessibilityHidden(true)
    }
}

/// The strip's checkbox: the accent fill with its own ink tick when checked, an outline when not.
private struct StripCheckbox: View {
    let checked: Bool
    var body: some View {
        RoundedRectangle(cornerRadius: AceTheme.Radii.badge)
            .fill(checked ? AceTheme.Colours.accent : Color.clear)
            .overlay {
                if checked {
                    Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)).foregroundStyle(AceTheme.Colours.onAccent)
                } else {
                    RoundedRectangle(cornerRadius: AceTheme.Radii.badge).strokeBorder(AceTheme.Colours.decoration, lineWidth: AceTheme.Dimensions.border)
                }
            }
            .frame(width: 15, height: 15)
            .accessibilityHidden(true)
    }
}
