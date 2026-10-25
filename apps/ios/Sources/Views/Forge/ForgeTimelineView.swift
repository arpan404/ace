import SwiftUI

/// A pull request's Timeline (the web's Timeline tab, cardless): comments, reviews, line
/// conversations, commits and events oldest first, hairline-separated, with the comment box at
/// the newest end. Review in the toolbar opens the Review sheet with the pending line comments.
/// A write that GitHub hasn't confirmed shows above the box with Reconcile; nothing is resent.
struct ForgeTimelineView: View {
    let client: ClientModel
    let route: ForgeRoute
    @State private var timeline: ForgeTimeline?
    @State private var failure: String?
    @State private var desk: ForgeReviewDesk?
    @State private var draft = ""
    @State private var composing: ForgeCompose?
    @State private var reviewing = false
    @FocusState private var boxFocused: Bool
    private var request: [String: Any] { ClientModel.forgeTimelineRead(project: route.project, number: route.number) }

    init(client: ClientModel, route: ForgeRoute) {
        self.client = client
        self.route = route
        let kept = client.kept(ClientModel.forgeTimelineRead(project: route.project, number: route.number), as: ForgeTimeline.self)
        _timeline = State(initialValue: kept)
        _desk = State(initialValue: kept.map { ForgeReviewDesk(client: client, target: ForgePullTarget(project: route.project, number: $0.number, repository: $0.repository)) })
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                if let timeline, let desk { rows(timeline, desk) }
                else if let failure {
                    EmptyState(icon: nil, title: "Couldn't load the timeline", line: failure, failed: true) {
                        Button("Try again") { Task { await load() } }
                    }
                    .padding(.top, 120)
                } else {
                    ProgressView().padding(.top, 120).frame(maxWidth: .infinity)
                }
            }
            .defaultScrollAnchor(.bottom)
            .onChange(of: timeline?.rows.last?.id) { _, last in
                if let last { withAnimation(.smooth) { proxy.scrollTo(last, anchor: .bottom) } }
            }
        }
        .background(AceTheme.Colours.background)
        .refreshable { await load() }
        .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) {
            if let timeline, let desk { bottom(timeline, desk) }
        }
        .navigationTitle("Timeline")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let review = timeline?.review {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(review.drafts.isEmpty ? "Review" : "Review · \(review.drafts.count)") { reviewing = true }
                        .accessibilityIdentifier("forge.review.open")
                }
            }
        }
        .task(id: client.readGeneration(request)) { await load() }
        .sheet(item: $composing) { compose in
            if let desk { ForgeWriteSheet(compose: compose, desk: desk) }
        }
        .sheet(isPresented: $reviewing) {
            if let review = timeline?.review, let desk { ForgeReviewSheetView(sheet: review, desk: desk) }
        }
    }

    private func rows(_ timeline: ForgeTimeline, _ desk: ForgeReviewDesk) -> some View {
        LazyVStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            if timeline.partial, let link = URL(string: timeline.url) {
                Link("Earlier activity on GitHub", destination: link)
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.sm)
            }
            ForEach(timeline.rows) { row in
                ForgeTimelineRowView(row: row, actions: ForgeCommentActions(desk: desk, compose: { composing = $0 }, quote: quote))
                    .padding(.horizontal, AceTheme.Spacing.lg)
                    .padding(.vertical, AceTheme.Spacing.md)
                    .id(row.id)
                Divider().overlay(AceTheme.Colours.separator).padding(.leading, AceTheme.Spacing.lg)
            }
        }
        .padding(.bottom, AceTheme.Spacing.md)
    }

    /// The status line (a refusal, a lost answer, writes to reconcile), then the comment box.
    @ViewBuilder private func bottom(_ timeline: ForgeTimeline, _ desk: ForgeReviewDesk) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            if let unread = timeline.unread { Text(unread).meta() }
            if let message = desk.message, composing == nil, !reviewing {
                Text(message).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTone.failed.text)
                    .accessibilityIdentifier("forge.review.message")
            }
            ForEach(timeline.uncertain, id: \.self) { operation in
                HStack {
                    Text("Review change not confirmed").meta()
                    Spacer(minLength: AceTheme.Spacing.sm)
                    Button("Reconcile") { Task { await desk.run(["kind": "reconcile", "operationId": operation]) } }
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .disabled(!desk.ready)
                        .accessibilityIdentifier("forge.review.reconcile")
                }
            }
            if let box = timeline.box { commentBox(box, desk) }
        }
        .padding(.horizontal, AceTheme.Spacing.lg)
        .padding(.vertical, AceTheme.Spacing.sm)
        .background(AceTheme.Colours.background)
        .overlay(alignment: .top) { Divider().overlay(AceTheme.Colours.separator) }
    }

    @ViewBuilder private func commentBox(_ box: ForgeBox, _ desk: ForgeReviewDesk) -> some View {
        HStack(alignment: .bottom, spacing: AceTheme.Spacing.sm) {
            ForgeEditor(text: $draft, placeholder: "Leave a comment", maxLines: 6, completer: desk.completer)
                .focused($boxFocused)
                .disabled(box.off != nil)
            Button("Comment") { send(desk) }
                .fontWeight(.semibold)
                .buttonStyle(.borderedProminent).buttonBorderShape(.capsule)
                .tint(AceTheme.Colours.foreground).foregroundStyle(AceTheme.Colours.background)
                .frame(minHeight: 44)
                .disabled(box.off != nil || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !desk.ready)
                .accessibilityIdentifier("forge.timeline.comment")
        }
        if let off = box.off { Text(off).meta().accessibilityIdentifier("forge.timeline.locked") }
    }

    /// Quote reply lands in the box, on a new paragraph after anything already written.
    private func quote(_ text: String) {
        draft = draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? text : draft + "\n\n" + text
        boxFocused = true
    }

    private func send(_ desk: ForgeReviewDesk) {
        let body = draft
        Task {
            // Text typed while it posted stays, to send next.
            if await desk.run(["kind": "conversation", "body": body]), draft == body { draft = "" }
        }
    }

    private func load() async {
        do {
            let read = try await client.forgeTimeline(project: route.project, number: route.number)
            if desk == nil { desk = ForgeReviewDesk(client: client, target: ForgePullTarget(project: route.project, number: read.number, repository: read.repository)) }
            timeline = read
            failure = nil
        } catch is CancellationError {
        } catch { failure = error.localizedDescription }
    }
}

/// One Timeline row by its kind.
struct ForgeTimelineRowView: View {
    let row: ForgeTimelineRow
    let actions: ForgeCommentActions

    var body: some View {
        switch row {
        case .comment(_, let comment):
            ForgeCommentView(comment: comment, actions: actions)
        case .review(_, let comment, let words, let tone, let stale):
            ForgeCommentView(comment: comment, words: stale ? "\(words) · earlier commit" : words, tone: stale ? nil : tone, actions: actions)
        case .thread(_, let thread):
            ForgeThreadBlock(thread: thread, desk: actions.desk, compose: actions.compose)
        case .event(_, let actor, let text, let tone, let at):
            line(actor: actor, text: text, tone: tone, at: at)
        case .commit(_, let sha, let title, let author, let at):
            HStack(spacing: AceTheme.Spacing.sm) {
                AceIcon(.gitBranch, size: 14, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.subtleForeground)
                Text(title).foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
                Spacer(minLength: AceTheme.Spacing.sm)
                Text(sha).aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.subtleForeground)
                if let at { ForgeAge(at: at) }
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(author) committed \(title)")
        case .references(_, let lines):
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, reference in
                    line(actor: reference.actor, text: reference.text, tone: nil, at: nil)
                }
            }
        case .unknown:
            EmptyView()
        }
    }

    private func line(actor: String, text: String, tone: String?, at: Double?) -> some View {
        HStack(spacing: AceTheme.Spacing.xs) {
            Text(actor).fontWeight(.medium).foregroundStyle(AceTheme.Colours.foreground)
            Text(text).foregroundStyle(tone.map { AceTone($0).text } ?? AceTheme.Colours.mutedForeground).lineLimit(2)
            Spacer(minLength: AceTheme.Spacing.sm)
            if let at { ForgeAge(at: at) }
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
        .foregroundStyle(AceTheme.Colours.mutedForeground)
        .accessibilityElement(children: .combine)
    }
}
