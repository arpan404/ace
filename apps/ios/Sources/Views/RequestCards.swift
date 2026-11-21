import SwiftUI

/// A request's content on the grouped surface above the composer: the surface is
/// `StripSurface`'s; an answer on its way taps the haptic.
struct RequestCardFrame: ViewModifier {
    let submission: ApprovalSubmission?
    func body(content: Content) -> some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .sensoryFeedback(AceDesign.Haptic.approve, trigger: submission?.requestId)
    }
}

/// The composer's frame: the dock's glass as a capsule that stops rounding once it wraps, inset from the screen's edges. The
/// composer, a question in its place, and the notes that replace it share it.
struct ComposerFrame: ViewModifier {
    var padding = EdgeInsets()
    @Environment(\.horizontalSizeClass) private var sizeClass
    func body(content: Content) -> some View {
        let bar = ReadingColumn.bar(sizeClass)
        content
            .padding(padding)
            .aceContainerShape(AceShape.field)
            .composerGlass(in: AceShape.field)
            .padding(.horizontal, bar.composer).padding(.bottom, bar.bottom)
    }
}

/// The inset surface inside a request card (a command, a plan, a choice): the page colour in
/// dark, where the card is lighter than the page, and the faint grey in light, where both are white.
/// Its corners are concentric with the surface around it.
private struct RequestInset: ViewModifier {
    @Environment(\.colorScheme) private var colourScheme
    func body(content: Content) -> some View {
        content.aceConcentricBackground(colourScheme == .dark ? AceTheme.Colours.background : AceTheme.Colours.secondaryBackground,
                                        minimum: StripMetrics.insetRadius)
    }
}
extension View {
    func requestInset() -> some View { modifier(RequestInset()) }
}

/// The request's question as a semibold line, and one muted line under it.
struct RequestHeader: View {
    let title: String
    var detail = ""
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            Text(title).aceFont(AceTheme.Typography.body, relativeTo: .body).fontWeight(AceDesign.Typeface.strong)
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
/// A request card's answer as the strip draws it (#2165): a capsule at least 44 points tall,
/// the way on prominent in the accent, the rest bordered in ink. In `RequestActions`' stacked
/// layout it takes the card's width.
struct CardButton: View {
    let title: String
    var primary = false
    var enabled = true
    let action: () -> Void
    @Environment(\.cardButtonFills) private var fills
    var body: some View {
        Button(action: action) {
            Text(title)
                .aceFont(AceDesign.TextRole.action, relativeTo: .subheadline)
                .fontWeight(primary ? AceDesign.Typeface.strong : AceDesign.Typeface.regular)
                .lineLimit(1)
                .frame(maxWidth: fills ? .infinity : nil)
        }
        .modifier(StripButtonLook(primary: primary))
        .buttonBorderShape(.capsule)
        .controlSize(.large)
        .frame(minHeight: AceDesign.Size.tap)
        .fixedSize(horizontal: !fills, vertical: false)
        .disabled(!enabled)
    }
}

extension EnvironmentValues {
    /// Card answers stacked one per line take the card's width.
    @Entry var cardButtonFills = false
}

/// A plan waiting for review, as one line above the composer like every request strip: "Plan
/// ready · Kill-all filters · 3 steps", then Review and Approve as buttons. Review opens the
/// whole plan in a sheet, where it can be approved or sent back with what should change. The
/// transcript shows nothing big.
struct PlanReviewCard: View {
    let interaction: ApprovalRow
    let submission: ApprovalSubmission?
    var canAct = true
    let answer: ([String: Any]) -> Void
    @State private var reviewing = false
    var body: some View {
        let plan = interaction.plan
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: AceDesign.Space.tight) { line(plan); Spacer(minLength: AceDesign.Space.related); buttons }
                VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    line(plan)
                    HStack(spacing: AceDesign.Space.tight) { Spacer(minLength: AceTheme.Spacing.none); buttons }
                }
            }
            RequestFooter(submission: submission, canAct: canAct)
        }
        .modifier(RequestCardFrame(submission: submission))
        .sheet(isPresented: $reviewing) {
            PlanReviewSheet(plan: plan, summarized: interaction.summarized ?? "", submission: submission, canAct: canAct) { decision in
                reviewing = false
                answer(decision)
            }
        }
    }
    private func line(_ plan: PlanRequest?) -> some View {
        Text(plan?.line ?? plan?.title ?? "Plan ready")
            .aceFont(AceTheme.Typography.body, relativeTo: .body).fontWeight(AceDesign.Typeface.regular)
            .foregroundStyle(AceTheme.Colours.foreground)
            .lineLimit(1).truncationMode(.tail)
            .accessibilityIdentifier("plan.line")
    }
    private var buttons: some View {
        HStack(spacing: AceDesign.Space.related) {
            CardButton(title: "Review") { reviewing = true }
                .accessibilityIdentifier("plan.review")
            // A plan too large to review here is approved on a computer.
            if !interaction.tooLargeToApprove {
                CardButton(title: "Approve", primary: true) { answer(["kind": "plan", "decision": "approve"]) }
                    .disabled(submission != nil || !canAct)
                    .accessibilityIdentifier("plan.approve")
            }
        }
        .fixedSize()
    }
}

/// The whole plan in a native sheet: its summary and markdown as the transcript draws prose, with
/// no box around it, then Request changes and Approve plan at the bottom. Request changes asks
/// what should change before it sends.
struct PlanReviewSheet: View {
    let plan: PlanRequest?
    /// Why it can only be sent back here (ADR 0157); "" when the plan came whole.
    var summarized = ""
    let submission: ApprovalSubmission?
    let canAct: Bool
    let answer: ([String: Any]) -> Void
    @State private var revising = false
    @State private var feedback = ""
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: AceDesign.Space.row) {
                    if let plan, !plan.summary.isEmpty {
                        Text(plan.summary).aceFont(AceTheme.Typography.body, relativeTo: .body)
                            .foregroundStyle(AceTheme.Colours.mutedForeground)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    AceMarkdown(text: plan?.markdown ?? "")
                    ForEach(Array((plan?.todos ?? []).enumerated()), id: \.offset) { _, todo in
                        Label(todo.text, ace: todo.status == "completed" ? .checkCircle : todo.status == "in_progress" ? .circleHalf : .circle)
                            .aceFont(AceTheme.Typography.body, relativeTo: .body).foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                    if !summarized.isEmpty {
                        Text(summarized).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                            .foregroundStyle(AceTheme.Colours.mutedForeground)
                    } else if plan?.truncated == true {
                        Text("The full plan is on your machine").aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                            .foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, AceDesign.Space.margin)
                .padding(.vertical, AceDesign.Space.row)
                .accessibilityIdentifier("plan.body")
            }
            .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) { actions }
            .navigationTitle(plan?.title ?? "Plan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(ace: .x) }
                        .accessibilityLabel("Close").accessibilityIdentifier("plan.close")
                }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }
    private var actions: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.related) {
            if revising {
                TextField("What should change?", text: $feedback, axis: .vertical)
                    .aceFont(AceTheme.Typography.body, relativeTo: .body).lineLimit(2...5)
                    .padding(.vertical, AceDesign.Space.related).frame(minHeight: AceDesign.Size.tap)
                    .accessibilityIdentifier("plan.feedback")
            }
            HStack(spacing: AceDesign.Space.related) {
                Spacer(minLength: AceTheme.Spacing.none)
                CardButton(title: revising ? "Cancel" : "Request changes") { revising.toggle() }
                    .accessibilityIdentifier("plan.revise")
                if revising {
                    let words = feedback.trimmingCharacters(in: .whitespacesAndNewlines)
                    CardButton(title: "Send feedback", primary: true, enabled: !words.isEmpty) {
                        answer(["kind": "plan", "decision": "reject", "feedback": words])
                    }.accessibilityIdentifier("plan.send")
                } else if summarized.isEmpty {
                    CardButton(title: "Approve plan", primary: true) { answer(["kind": "plan", "decision": "approve"]) }
                        .accessibilityIdentifier("plan.approveFull")
                }
            }
            .disabled(submission != nil || !canAct)
            RequestFooter(submission: submission, canAct: canAct)
        }
        .padding(.horizontal, AceDesign.Space.margin)
        .padding(.vertical, AceDesign.Space.row)
        .background(.bar)
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
        VStack(alignment: .leading, spacing: AceDesign.Space.row) {
            RequestHeader(title: form?.title ?? "", detail: form?.server ?? "")
            if let form, form.message != form.title, !form.message.isEmpty {
                Text(form.message).aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            if interaction.tooLargeToApprove {
                Text(interaction.summarized ?? "")
                    .aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground)
            } else if form?.unsupported == true {
                Text(form?.mode == "url" ? "This request has no safe consent page. Decline or cancel it." : "This form can't be filled in here. Decline or cancel it.")
                    .aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.StatusText.failed)
            }
            if let form, form.mode == "url", let url = URL(string: form.url), !form.url.isEmpty {
                Link("Open consent page", destination: url)
                    .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
            }
            VStack(spacing: AceTheme.Spacing.none) {
                ForEach(Array((form?.fields ?? []).enumerated()), id: \.element.id) { index, field in fieldView(field, first: index == 0) }
            }
            RequestActions {
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
    /// One field as a grouped row: its name on the left; a choice's value and chevron, or the
    /// typed value, on the right.
    @ViewBuilder private func fieldView(_ field: FormRequest.Field, first: Bool) -> some View {
        let value = Binding(get: { values[field.key] ?? field.initial }, set: { values[field.key] = $0 })
        GroupedRow(first: first) {
            if field.choices.isEmpty {
                HStack(spacing: AceDesign.Space.row) {
                    Text(field.title).lineLimit(1).layoutPriority(1)
                    TextField(field.title, text: value, prompt: Text(prompt(field)).foregroundStyle(AceTheme.Colours.subtleForeground))
                        .keyboardType(field.type == "string" ? .default : field.type == "integer" ? .numberPad : .decimalPad)
                        .multilineTextAlignment(.trailing)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                        .accessibilityHint(field.detail)
                }
            } else {
                Menu {
                    Picker(field.title, selection: value) {
                        ForEach(field.choices) { choice in Text(choice.label).tag(choice.value) }
                    }
                } label: {
                    HStack(spacing: AceDesign.Space.row) {
                        Text(field.title).lineLimit(1).foregroundStyle(AceTheme.Colours.foreground)
                        Spacer(minLength: AceDesign.Space.related)
                        GroupedValue(text: field.choices.first { $0.value == value.wrappedValue }?.label ?? (field.required ? "Choose" : "Optional"))
                    }
                    .frame(minHeight: AceDesign.Size.tap).contentShape(Rectangle())
                }
                .accessibilityLabel(field.title)
                .accessibilityValue(field.choices.first { $0.value == value.wrappedValue }?.label ?? "Not chosen")
                .accessibilityHint(field.detail)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("form.field.\(field.key)")
    }
    /// What an empty field says: its hint ("Between 1 and 5"), else whether it must be filled.
    private func prompt(_ field: FormRequest.Field) -> String {
        if !field.detail.isEmpty { return field.detail }
        return field.required ? "Required" : "Optional"
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

/// A request's answers on one row at the trailing edge, as the strip lays them out; on a narrow
/// screen or at large text they stack full width, the way on last, nearest the thumb.
struct RequestActions<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: AceDesign.Space.related) { Spacer(minLength: AceTheme.Spacing.none); content() }
            VStack(spacing: AceDesign.Space.related) { content() }
                .environment(\.cardButtonFills, true)
        }
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
        VStack(alignment: .leading, spacing: AceDesign.Space.row) {
            RequestHeader(title: interaction.help?.title ?? "", detail: "Browser")
            if let detail = interaction.help?.detail, !detail.isEmpty {
                Text(detail).aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            // A request mirrored from another machine waits on a tab there: this thread's browser
            // isn't it, so there's nothing to open here.
            if let openBrowser, interaction.help?.elsewhere != true {
                CardButton(title: "Open browser", action: openBrowser)
                    .accessibilityIdentifier("help.open")
            } else {
                Text(interaction.help?.elsewhere == true ? "The tab is open on the machine that asked." : "The tab is open on your machine.").aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.subtleForeground)
            }
            RequestActions {
                CardButton(title: "Skip") { answer(["kind": "help", "outcome": "skipped"]) }
                CardButton(title: "Done", primary: true) { answer(["kind": "help", "outcome": "done"]) }
                    .accessibilityIdentifier("help.done")
            }.disabled(submission != nil || !canAct)
            RequestFooter(submission: submission, canAct: canAct)
        }
        .modifier(RequestCardFrame(submission: submission))
    }
}
