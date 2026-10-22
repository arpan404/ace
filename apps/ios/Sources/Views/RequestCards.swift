import SwiftUI

/// A request's content inside the composer's strip (or, for a question, the composer's own
/// frame): the surface is the strip's; an answer on its way taps the haptic.
struct RequestCardFrame: ViewModifier {
    let submission: ApprovalSubmission?
    func body(content: Content) -> some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .sensoryFeedback(.selection, trigger: submission?.requestId)
    }
}

/// The composer's frame: the dock's glass at `rounded-xl`, inset from the screen's edges. The
/// composer, a question in its place, and the notes that replace it share it.
struct ComposerFrame: ViewModifier {
    var padding = EdgeInsets()
    func body(content: Content) -> some View {
        content
            .padding(padding)
            .aceGlass(in: RoundedRectangle(cornerRadius: StripMetrics.radius, style: .continuous))
            .padding(.horizontal, AceTheme.Spacing.md).padding(.bottom, AceTheme.Spacing.sm)
    }
}

/// The inset surface inside a request card (a command, a plan, a choice): the page colour in
/// dark, where the card is lighter than the page, and the faint grey in light, where both are white.
private struct RequestInset: ViewModifier {
    @Environment(\.colorScheme) private var colourScheme
    let cornerRadius: CGFloat
    func body(content: Content) -> some View {
        content.background(colourScheme == .dark ? AceTheme.Colours.background : AceTheme.Colours.secondaryBackground,
                           in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }
}
extension View {
    func requestInset(cornerRadius: CGFloat) -> some View { modifier(RequestInset(cornerRadius: cornerRadius)) }
}

/// The request's title (500) and one muted line under it.
struct RequestHeader: View {
    let title: String
    var detail = ""
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            Text(title).aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                .foregroundStyle(AceTheme.Colours.foreground)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if !detail.isEmpty {
                Text(detail).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
/// The view-only note, or "Sending…" while the answer is on its way to the machine.
struct RequestFooter: View {
    let submission: ApprovalSubmission?
    let canAct: Bool
    var body: some View {
        if !canAct { ViewOnlyNote.approval }
        if submission != nil {
            Text("Sending…").aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .frame(maxWidth: .infinity)
        }
    }
}
/// A request card's answer: the primary choice in ink, the rest outlined.
struct CardButton: View {
    let title: String
    var primary = false
    var enabled = true
    let action: () -> Void
    var body: some View {
        Button(title, action: action).buttonStyle(RequestButtonStyle(primary: primary)).disabled(!enabled)
    }
}

/// A plan to approve as is, or send back with what should change.
struct PlanReviewCard: View {
    let interaction: ApprovalRow
    let submission: ApprovalSubmission?
    var canAct = true
    let answer: ([String: Any]) -> Void
    @State private var revising = false
    @State private var feedback = ""
    /// The plan's scroll area grows with the text size, so large text still shows a few lines.
    @ScaledMetric(relativeTo: .body) private var planHeight = AceTheme.Dimensions.touchTarget * 5
    var body: some View {
        let plan = interaction.plan
        VStack(alignment: .leading, spacing: AceTheme.Spacing.md) {
            RequestHeader(title: plan?.title ?? "Review the plan", detail: "Plan review")
            if let plan, !plan.summary.isEmpty {
                Text(plan.summary).aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
                    MarkdownView(text: plan?.markdown ?? "")
                    ForEach(Array((plan?.todos ?? []).enumerated()), id: \.offset) { _, todo in
                        Label(todo.text, ace: todo.status == "completed" ? .checkCircle : todo.status == "in_progress" ? .circleHalf : .circle)
                            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                    if plan?.truncated == true { Text("The full plan is on your machine").aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: planHeight)
            .padding(AceTheme.Spacing.md).requestInset(cornerRadius: AceTheme.Radii.lg)
            .accessibilityIdentifier("plan.body")
            if revising {
                TextField("What should change?", text: $feedback, axis: .vertical)
                    .aceFont(AceTheme.Typography.body, relativeTo: .body).lineLimit(2...5)
                    .padding(AceTheme.Spacing.md).frame(minHeight: AceTheme.Dimensions.touchTarget)
                    .background(AceTheme.Colours.fill, in: RoundedRectangle(cornerRadius: AceTheme.Radii.md))
                    .accessibilityIdentifier("plan.feedback")
            }
            HStack(spacing: AceTheme.Spacing.sm) {
                CardButton(title: revising ? "Cancel" : "Request changes") { revising.toggle() }
                    .accessibilityIdentifier("plan.revise")
                if revising {
                    let words = feedback.trimmingCharacters(in: .whitespacesAndNewlines)
                    CardButton(title: "Send feedback", primary: true, enabled: !words.isEmpty) {
                        answer(["kind": "plan", "decision": "reject", "feedback": words])
                    }.accessibilityIdentifier("plan.send")
                } else {
                    CardButton(title: "Approve plan", primary: true) { answer(["kind": "plan", "decision": "approve"]) }
                        .accessibilityIdentifier("plan.approve")
                }
            }.disabled(submission != nil || !canAct)
            RequestFooter(submission: submission, canAct: canAct)
        }
        .modifier(RequestCardFrame(submission: submission))
    }
}

/// An MCP server's form, or its consent page. Values are typed as text; the bridge checks them
/// against the server's schema before anything is saved.
struct FormRequestCard: View {
    let interaction: ApprovalRow
    let submission: ApprovalSubmission?
    var canAct = true
    let answer: ([String: Any]) -> Void
    @State private var values: [String: String] = [:]
    var body: some View {
        let form = interaction.form
        VStack(alignment: .leading, spacing: AceTheme.Spacing.md) {
            RequestHeader(title: form?.title ?? "", detail: form?.server ?? "")
            if let form, form.message != form.title, !form.message.isEmpty {
                Text(form.message).aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            if form?.unsupported == true {
                Text(form?.mode == "url" ? "This request has no safe consent page. Decline or cancel it." : "This form can't be filled in here. Decline or cancel it.")
                    .aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.StatusText.failed)
            }
            if let form, form.mode == "url", let url = URL(string: form.url), !form.url.isEmpty {
                Link(destination: url) { Label("Open consent page", ace: .compass) }
                    .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
            }
            ForEach(form?.fields ?? []) { field in fieldView(field) }
            HStack(spacing: AceTheme.Spacing.sm) {
                CardButton(title: "Cancel") { answer(["kind": "form", "action": "cancel"]) }
                CardButton(title: "Decline") { answer(["kind": "form", "action": "decline"]) }
                    .accessibilityIdentifier("form.decline")
                CardButton(title: "Continue", primary: true, enabled: form?.unsupported == false && filled(form)) {
                    answer(["kind": "form", "action": "accept", "values": submitted(form)])
                }.accessibilityIdentifier("form.submit")
            }.disabled(submission != nil || !canAct)
            RequestFooter(submission: submission, canAct: canAct)
        }
        .modifier(RequestCardFrame(submission: submission))
    }
    @ViewBuilder private func fieldView(_ field: FormRequest.Field) -> some View {
        let value = Binding(get: { values[field.key] ?? field.initial }, set: { values[field.key] = $0 })
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            Text(field.required ? "\(field.title) *" : field.title).aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
            if field.choices.isEmpty {
                TextField(field.title, text: value)
                    .keyboardType(field.type == "string" ? .default : field.type == "integer" ? .numberPad : .decimalPad)
                    .aceFont(AceTheme.Typography.body, relativeTo: .body)
                    .padding(AceTheme.Spacing.md).frame(minHeight: AceTheme.Dimensions.touchTarget)
                    .background(AceTheme.Colours.fill, in: RoundedRectangle(cornerRadius: AceTheme.Radii.md))
            } else {
                Picker(field.title, selection: value) {
                    Text("Choose…").tag("")
                    ForEach(field.choices) { choice in Text(choice.label).tag(choice.value) }
                }.pickerStyle(.menu).frame(minHeight: AceTheme.Dimensions.touchTarget)
            }
            if !field.detail.isEmpty { Text(field.detail).aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("form.field.\(field.key)")
    }
    private func submitted(_ form: FormRequest?) -> [String: String] {
        var result: [String: String] = [:]
        for field in form?.fields ?? [] {
            let value = (values[field.key] ?? field.initial).trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty { result[field.key] = value }
        }
        return result
    }
    private func filled(_ form: FormRequest?) -> Bool {
        let given = submitted(form)
        return (form?.fields ?? []).allSatisfy { !$0.required || given[$0.key] != nil }
    }
}

/// A browser tab on the agent's machine needs the person: they finish it in the live view (or on
/// the machine), then say Done.
struct BrowserHelpCard: View {
    let interaction: ApprovalRow
    let submission: ApprovalSubmission?
    var canAct = true
    /// Opens the thread's browser live on the phone.
    var openBrowser: (() -> Void)?
    let answer: ([String: Any]) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.md) {
            RequestHeader(title: interaction.help?.title ?? "", detail: "Browser")
            if let detail = interaction.help?.detail, !detail.isEmpty {
                Text(detail).aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            if let openBrowser {
                CardButton(title: "Open browser", action: openBrowser)
                    .accessibilityIdentifier("help.open")
            } else {
                Text("The tab is open on your machine.").aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.subtleForeground)
            }
            HStack(spacing: AceTheme.Spacing.sm) {
                CardButton(title: "Skip") { answer(["kind": "help", "outcome": "skipped"]) }
                CardButton(title: "Done", primary: true) { answer(["kind": "help", "outcome": "done"]) }
                    .accessibilityIdentifier("help.done")
            }.disabled(submission != nil || !canAct)
            RequestFooter(submission: submission, canAct: canAct)
        }
        .modifier(RequestCardFrame(submission: submission))
    }
}
