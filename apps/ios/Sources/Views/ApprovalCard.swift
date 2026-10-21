import SwiftUI

/// A permission request in the composer's strip, as the web draws it: what it asks, the command
/// in a code block, a high or medium risk on one line, then the request's own verbs (Allow once
/// primary, the rest secondary) and Details ›, which holds the reason and any other option the
/// request offers.
struct ApprovalCard: View {
    let approval: ApprovalRow
    let submission: ApprovalSubmission?
    /// False on a view-only pairing: the card still shows the request, without live choices.
    var canAct = true
    let resolve: (ApprovalRow.Option) -> Void
    @State private var details = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.md - AceTheme.Spacing.xxs) {
            Text(nonEmpty(approval.heading) ?? approval.title)
                .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                .foregroundStyle(AceTheme.Colours.foreground)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if !approval.command.isEmpty { CommandBlock(command: approval.command) }
            if let level = riskLevel, let text = nonEmpty(approval.riskText) {
                (Text(level).fontWeight(.medium).foregroundStyle(approval.risk == "high" ? AceTheme.StatusText.failed : AceTheme.StatusText.needsYou)
                 + Text(" · \(text)").foregroundStyle(AceTheme.Colours.mutedForeground))
                    .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if approval.truncated {
                Text("Some details are shortened for display").aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            // One row when it fits; on a narrow screen or large text, Details goes under the answers.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: AceTheme.Spacing.sm) {
                    answerRow
                    Spacer(minLength: AceTheme.Spacing.none)
                    detailsToggle
                }
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                    answerRow
                    detailsToggle
                }
            }
            if details { detailsBody }
            RequestFooter(submission: submission, canAct: canAct)
        }
        .modifier(RequestCardFrame(submission: submission))
    }
    private var riskLevel: String? {
        switch approval.risk {
        case "high": "High risk"
        case "medium": "Medium risk"
        default: nil
        }
    }
    private var reason: String? { nonEmpty(approval.reason) ?? nonEmpty(approval.description) }
    private var hasDetails: Bool { reason != nil || !others.isEmpty }
    /// Options beyond the buttons: the request's other options, or, from a daemon that sends no
    /// verbs, everything past Allow once and Deny.
    private var others: [ApprovalRow.Remaining] {
        if !approval.verbs.isEmpty { return approval.remaining }
        let shown = Set(offered.map(\.id))
        return approval.options.filter { !shown.contains($0.id) }.map { ApprovalRow.Remaining(label: $0.label, option: $0) }
    }
    /// From a daemon that sends no verbs: Allow once and Deny, as offered.
    private var offered: [ApprovalRow.Option] {
        approval.options.filter { $0.kind == "allow_once" || $0.kind == "deny" }.sorted { $0.kind == "allow_once" && $1.kind != "allow_once" }
    }
    private var answerRow: some View {
        HStack(spacing: AceTheme.Spacing.sm) { answers }.disabled(submission != nil || !canAct)
    }
    @ViewBuilder private var detailsToggle: some View {
        if hasDetails {
            Button { withAnimation(reduceMotion ? nil : AceTheme.Motion.standardCurve) { details.toggle() } } label: {
                HStack(spacing: AceTheme.Spacing.xs) {
                    Text("Details")
                    Image(systemName: "chevron.right").font(.caption2.weight(.semibold))
                        .foregroundStyle(AceTheme.Colours.subtleForeground)
                        .rotationEffect(.degrees(details ? 90 : 0))
                }
            }
            .buttonStyle(StripTextButtonStyle())
            .accessibilityValue(details ? "Expanded" : "Collapsed")
            .accessibilityIdentifier("approval.details")
        }
    }
    @ViewBuilder private var answers: some View {
        if approval.verbs.isEmpty {
            ForEach(offered) { option in
                Button(option.label) { resolve(option) }
                    .buttonStyle(RequestButtonStyle(primary: option.kind == "allow_once"))
                    .accessibilityIdentifier("approval.\(option.kind)")
            }
        } else {
            // Allow once first, then Always allow, then Deny: the web's order.
            let order = ["allow_once": 0, "always_allow": 1, "deny": 2]
            ForEach(approval.verbs.sorted { (order[$0.decision.verb] ?? 1) < (order[$1.decision.verb] ?? 1) }) { verb in
                Button(verb.decision.label) { resolve(verb.option) }
                    .buttonStyle(RequestButtonStyle(primary: verb.decision.emphasis == "primary"))
                    .accessibilityLabel(verb.decision.scope.isEmpty ? verb.decision.label : "\(verb.decision.label): \(verb.decision.scope)")
                    .accessibilityIdentifier("approval.\(verb.option.kind)")
            }
        }
    }
    private var detailsBody: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            if let reason {
                Text(reason).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !others.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: AceTheme.Spacing.xs) {
                        ForEach(others) { other in
                            Button(other.label) { resolve(other.option) }
                                .buttonStyle(StripTextButtonStyle())
                                .accessibilityIdentifier("approval.\(other.option.kind)")
                        }
                    }
                }
                .disabled(submission != nil || !canAct)
            }
        }
        .transition(.opacity)
    }
    private func nonEmpty(_ value: String?) -> String? { value.flatMap { $0.isEmpty ? nil : $0 } }
}

/// A command the request acts on: `$ command` in mono on the code surface, scrolling past a few
/// lines.
struct CommandBlock: View {
    let command: String
    var body: some View {
        ScrollView(.vertical) {
            (Text("$ ").foregroundStyle(AceTheme.Colours.subtleForeground) + Text(command).foregroundStyle(AceTheme.Colours.foreground))
                .aceMonospace(AceTheme.Typography.code, relativeTo: .footnote)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, AceTheme.Spacing.md).padding(.vertical, AceTheme.Spacing.sm + AceTheme.Spacing.xxs)
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(maxHeight: AceTheme.Dimensions.touchTarget * 3)
        .fixedSize(horizontal: false, vertical: true)
        .requestInset(cornerRadius: AceTheme.Radii.small)
        .overlay(RoundedRectangle(cornerRadius: AceTheme.Radii.small, style: .continuous).strokeBorder(AceTheme.Colours.separator, lineWidth: AceTheme.Dimensions.border))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Command")
        .accessibilityValue(command)
    }
}

/// A request's answer: the one primary in ink, the rest outlined so they read as buttons at rest.
/// 44pt tall for a finger, `rounded-md`, flat.
struct RequestButtonStyle: ButtonStyle {
    var primary = false
    /// Takes the card's full width (a question's Continue).
    var wide = false
    @Environment(\.isEnabled) private var enabled
    @Environment(\.colorScheme) private var scheme
    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: AceTheme.Radii.small, style: .continuous)
        configuration.label
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .foregroundStyle(primary ? AceTheme.Colours.onAccent : AceTheme.Colours.foreground)
            .padding(.horizontal, AceTheme.Spacing.lg)
            .frame(maxWidth: wide ? .infinity : nil, minHeight: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.xs)
            .background(primary ? AceTheme.Colours.accent : (configuration.isPressed ? AceTheme.Colours.fill : .clear), in: shape)
            .overlay { if !primary { shape.strokeBorder(AceTheme.Colours.separator, lineWidth: AceTheme.Dimensions.border) } }
            .opacity(enabled ? (primary && configuration.isPressed ? 0.85 : 1) : AceTheme.Opacity.disabled(scheme))
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .contentShape(shape)
    }
}
