import SwiftUI

/// A permission request, right above the composer: what it asks in bold, one muted line, the
/// command in mono, then Allow once (primary), Always (quiet) and Deny (pale red), each the
/// request's own option. Every other offered option waits behind ⋯.
struct ApprovalCard: View {
    let approval: ApprovalRow
    let submission: ApprovalSubmission?
    /// False on a view-only pairing: the card still shows the request, without live choices.
    var canAct = true
    let resolve: (ApprovalRow.Option) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.md) {
            RequestHeader(title: nonEmpty(approval.heading) ?? approval.title, detail: nonEmpty(approval.reason) ?? approval.description)
            if approval.risk == "high", let risk = nonEmpty(approval.riskText) {
                Text(risk).aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.StatusText.failed)
            }
            if !approval.command.isEmpty {
                ScrollView(.vertical) {
                    Text(approval.command).aceMonospace(AceTheme.Typography.code, relativeTo: .footnote).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, AceTheme.Spacing.md).padding(.vertical, AceTheme.Spacing.md - AceTheme.Spacing.xxs)
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(maxHeight: AceTheme.Dimensions.touchTarget * 3)
                .fixedSize(horizontal: false, vertical: true)
                .requestInset(cornerRadius: AceTheme.Radii.code)
            }
            if approval.truncated { Text("Some details are shortened for display").aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground) }
            Group {
                if approval.verbs.isEmpty { offeredButtons } else { verbButtons }
            }.disabled(submission != nil || !canAct)
            RequestFooter(submission: submission, canAct: canAct)
        }
        .modifier(RequestCardFrame(submission: submission))
    }
    /// The verbs with the primary one first, then Always, then Deny.
    private var verbButtons: some View {
        let order = ["allow_once": 0, "always_allow": 1, "deny": 2]
        let verbs = approval.verbs.sorted { (order[$0.decision.verb] ?? 1) < (order[$1.decision.verb] ?? 1) }
        let remaining = approval.remaining
        return HStack(spacing: AceTheme.Spacing.sm) {
            ForEach(verbs) { verb in
                pill(verb.decision.label, kind: verb.decision.emphasis == "primary" ? .primary : verb.decision.verb == "deny" ? .refuse : .secondary) { resolve(verb.option) }
                    .accessibilityLabel(verb.decision.scope.isEmpty ? verb.decision.label : "\(verb.decision.label): \(verb.decision.scope)")
                    .accessibilityIdentifier("approval.\(verb.option.kind)")
            }
            if !remaining.isEmpty {
                Menu {
                    ForEach(remaining) { other in Button(other.label) { resolve(other.option) } }
                } label: { moreLabel }.accessibilityIdentifier("approval.more")
            }
        }
    }
    /// A row from a daemon that sends no verbs: the offered options as they come.
    private var offeredButtons: some View {
        // Allow once and Deny always stay in view; anything past three waits behind ⋯.
        let options = approval.options.sorted { rank($0.kind) < rank($1.kind) }
        let shown = options.prefix(options.count > 3 ? 2 : options.count).sorted { (rank($0.kind) == 1 ? 3 : rank($0.kind)) < (rank($1.kind) == 1 ? 3 : rank($1.kind)) }
        return HStack(spacing: AceTheme.Spacing.sm) {
            ForEach(shown) { option in
                pill(option.label, kind: option.kind == "allow_once" ? .primary : option.kind == "deny" ? .refuse : .secondary) { resolve(option) }
                    .accessibilityIdentifier("approval.\(option.kind)")
            }
            if options.count > 3 {
                Menu {
                    ForEach(options.dropFirst(2)) { option in Button(option.label) { resolve(option) } }
                } label: { moreLabel }.accessibilityIdentifier("approval.more")
            }
        }
    }
    private func pill(_ words: String, kind: PillButtonStyle.Kind, action: @escaping () -> Void) -> some View {
        Button(words, action: action).buttonStyle(PillButtonStyle(kind: kind))
    }
    private var moreLabel: some View {
        Image(systemName: "ellipsis")
            .foregroundStyle(AceTheme.Colours.foreground)
            .frame(width: AceTheme.Dimensions.touchTarget, height: AceTheme.Dimensions.touchTarget)
            .background(AceTheme.Colours.fill, in: Circle())
            .accessibilityLabel("More choices")
    }
    private func nonEmpty(_ value: String?) -> String? { value.flatMap { $0.isEmpty ? nil : $0 } }
    private func rank(_ kind: String) -> Int { kind == "allow_once" ? 0 : kind == "deny" ? 1 : 2 }
}
