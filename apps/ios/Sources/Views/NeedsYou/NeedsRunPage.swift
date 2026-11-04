import SwiftUI

/// One request in the needs-you run, on one left edge: where it comes from (provider, project ·
/// branch · age, the machine when there are several), who asks for what, the command, the
/// agent's last words as one muted paragraph, and the thread to open. An approval answers with
/// Deny and Allow once as capsules at the bottom, and a standing grant above them only when the
/// request offers one; other requests answer on the thread's own card.
struct NeedsRunPage: View {
    let entry: NeedsRunQueue.Entry
    let request: ApprovalRow
    let model: ClientModel
    let row: ThreadRow?
    let machine: String?
    let openThread: () -> Void
    let decided: () -> Void
    @State private var draft = QuestionDraftState()
    /// The whole plan, from a plan page's Review.
    @State private var reviewing = false

    private var threadId: String { entry.thread.id }
    private var actions: NeedActions {
        NeedActions(request: request, model: model, threadId: threadId, open: openThread, review: {}, decided: decided)
    }

    var body: some View {
        VStack(spacing: AceTheme.Spacing.none) {
            ScrollView {
                VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                    VStack(alignment: .leading, spacing: AceDesign.Space.related) {
                        origin
                        Text(NeedWords.sentence(request))
                            .aceFont(AceDesign.TextRole.header, relativeTo: .headline)
                            .foregroundStyle(AceTheme.Colours.foreground)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("run.sentence")
                    }
                    if request.kind == "approval" { approval } else if request.kind == "plan_review" { plan } else {
                        NeedsRequestCard(request: request, model: model, threadId: threadId, open: openThread, draft: $draft)
                    }
                    words
                    thread
                }
                .padding(.horizontal, AceDesign.Space.margin)
                .padding(.top, AceDesign.Space.row)
                .padding(.bottom, AceDesign.Space.group)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollBounceBehavior(.basedOnSize)
            if request.kind == "approval" { decisions } else if request.kind == "plan_review" { planDecisions }
        }
        .task(id: threadId) { model.readNeedsWords(threadId) }
        // An answer sent from the request's own card (a question, a form) is a decision too:
        // its haptic, and on to the next page. Approvals and plans count theirs where they're sent.
        .onChange(of: model.approvalSubmissions[request.id] != nil) { _, sent in
            if sent && !["approval", "plan_review"].contains(request.kind) { decided() }
        }
        .sheet(isPresented: $reviewing) {
            PlanReviewSheet(plan: request.plan, submission: model.approvalSubmissions[request.id], canAct: model.canOperate) { answer in
                reviewing = false
                model.answerNeed(request, in: threadId, answer: answer)
                decided()
            }
        }
    }

    /// Provider · project · branch · age, and the machine where there are several.
    private var origin: some View {
        HStack(spacing: AceDesign.Space.related) {
            if let provider = row?.provider {
                ProviderMark(provider: provider, size: AceDesign.Size.rowMark)
                    .opacity(AceDesign.Ink.markOpacity)
            }
            Text(originWords)
                .aceFont(InboxRowType.line, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.subtleForeground)
                .lineLimit(1).truncationMode(.middle)
        }
        .accessibilityElement(children: .combine)
    }
    private var originWords: String {
        let branch = row.map { $0.branchLabel ?? $0.branch } ?? ""
        let age = row.map { ActivityTime.age(since: Date(timeIntervalSince1970: ($0.activityAt ?? $0.updatedAt) / 1000), now: .now) }
        return [row?.project, branch, age, machine].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
    }

    /// The command whole (up to ten lines) in mono, then why, in muted ink.
    @ViewBuilder private var approval: some View {
        let command = request.command.isEmpty ? (request.strip?.payload ?? "") : request.command
        VStack(alignment: .leading, spacing: AceDesign.Space.row) {
            if !command.isEmpty {
                Text(command)
                    .font(AceDesign.Typeface.codeBody)
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .lineLimit(10)
                    .textSelection(.enabled)
                    .padding(.horizontal, AceDesign.Space.row)
                    .padding(.vertical, AceDesign.Space.related)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(AceDesign.Surface.fill, in: AceDesign.Shape.field)
                    .accessibilityIdentifier("run.command")
            }
            let why = [request.reason ?? "", request.description].first { !$0.isEmpty } ?? ""
            if !why.isEmpty {
                Text(why)
                    .aceFont(AceDesign.TextRole.segment, relativeTo: .subheadline)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .lineLimit(4)
            }
        }
    }

    /// A plan's summary and steps, quietly; the whole plan opens from Review.
    @ViewBuilder private var plan: some View {
        if let plan = request.plan {
            VStack(alignment: .leading, spacing: AceDesign.Space.related) {
                if !plan.summary.isEmpty {
                    Text(plan.summary)
                        .aceFont(AceDesign.TextRole.segment, relativeTo: .subheadline)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                        .lineLimit(4)
                }
                ForEach(Array(plan.todos.prefix(Self.planSteps).enumerated()), id: \.offset) { index, todo in
                    HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
                        Text("\(index + 1)").monospacedDigit()
                            .foregroundStyle(AceTheme.Colours.subtleForeground)
                        Text(todo.text).foregroundStyle(AceTheme.Colours.foreground).lineLimit(2)
                    }
                    .aceFont(AceDesign.TextRole.segment, relativeTo: .subheadline)
                }
                if plan.todos.count > Self.planSteps {
                    Text("\(plan.todos.count - Self.planSteps) more steps")
                        .aceFont(InboxRowType.line, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.subtleForeground)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("run.plan")
        }
    }
    /// Steps a plan page lists before "3 more steps".
    private static let planSteps = 6

    /// Review (the whole plan, where changes can be asked for) and Approve, in thumb reach.
    private var planDecisions: some View {
        HStack(spacing: AceDesign.Space.related) {
            if let progress = actions.progress {
                Text(progress)
                    .aceFont(AceDesign.TextRole.action, relativeTo: .subheadline)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap)
            } else {
                Button("Review") { reviewing = true }.buttonStyle(PillButtonStyle(kind: .secondary))
                    .accessibilityIdentifier("run.plan.review")
                if model.canOperate {
                    Button("Approve") {
                        model.answerNeed(request, in: threadId, answer: ["kind": "plan", "decision": "approve"])
                        decided()
                    }
                    .buttonStyle(PillButtonStyle(kind: .primary))
                    .accessibilityIdentifier("run.plan.approve")
                }
            }
        }
        .padding(.horizontal, AceDesign.Space.margin)
        .padding(.vertical, AceDesign.Space.related)
    }

    /// What the agent last said, as one muted paragraph.
    @ViewBuilder private var words: some View {
        if let said = model.needsWords[threadId], !said.isEmpty {
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                Text("Last message")
                    .aceFont(InboxRowType.line, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.subtleForeground)
                Text(said)
                    .aceFont(AceDesign.TextRole.segment, relativeTo: .subheadline)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .lineLimit(6)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("run.words")
        }
    }

    /// The thread it belongs to, to open.
    @ViewBuilder private var thread: some View {
        if let row {
            Button(action: openThread) {
                HStack(spacing: AceDesign.Space.related) {
                    Text(row.title)
                        .aceFont(InboxRowType.title, relativeTo: .callout)
                        .foregroundStyle(AceTheme.Colours.foreground)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: AceDesign.Space.related)
                    Image(systemName: "chevron.right")
                        .font(AceDesign.Typeface.meta.weight(AceDesign.Typeface.strong))
                        .foregroundStyle(AceTheme.Colours.subtleForeground)
                }
                .frame(minHeight: AceDesign.Size.tap)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens the thread")
            .accessibilityIdentifier("run.thread")
        }
    }

    /// Deny and Allow once in thumb reach; a standing grant above them only where offered.
    private var decisions: some View {
        let actions = actions
        return VStack(alignment: .leading, spacing: AceDesign.Space.related) {
            if let progress = actions.progress {
                Text(progress)
                    .aceFont(AceDesign.TextRole.action, relativeTo: .subheadline)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap)
            } else if !model.canOperate {
                Text("View only")
                    .aceFont(AceDesign.TextRole.action, relativeTo: .subheadline)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap)
            } else {
                if let always = actions.always {
                    HStack(spacing: AceDesign.Space.related) {
                        Button(always.label, action: always.run)
                            .buttonStyle(NeedWordStyle())
                            .accessibilityHint(actions.scope)
                            .accessibilityIdentifier("run.always")
                        // What it covers ("here", "for npm install"), quieter than the verb.
                        if !actions.scope.isEmpty {
                            Text(actions.scope)
                                .aceFont(InboxRowType.line, relativeTo: .footnote)
                                .foregroundStyle(AceTheme.Colours.subtleForeground)
                                .lineLimit(1)
                                .accessibilityHidden(true)
                        }
                    }
                    // The word's own inset sits outside the page's one left edge.
                    .padding(.leading, -AceDesign.Space.stripWord)
                }
                HStack(spacing: AceDesign.Space.related) {
                    if let deny = actions.deny {
                        Button(deny.label, action: deny.run).buttonStyle(PillButtonStyle(kind: .secondary))
                            .accessibilityIdentifier("run.deny")
                    }
                    if let allow = actions.allow {
                        Button(allow.label, action: allow.run).buttonStyle(PillButtonStyle(kind: .primary))
                            .accessibilityIdentifier("run.allow")
                    }
                }
            }
        }
        .padding(.horizontal, AceDesign.Space.margin)
        .padding(.top, AceDesign.Space.related)
        .padding(.bottom, AceDesign.Space.related)
    }
}
