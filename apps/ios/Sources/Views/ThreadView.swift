import SwiftUI

struct ThreadView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: ClientModel
    @Bindable var thread: ThreadModel
    /// Push another thread (a delegated child or a conversation this one started).
    let openThread: (String) -> Void
    @State private var showDetails = false
    @State private var showModels = false
    @State private var lane: BlockRow.Agents.Entry?
    @State private var scrolledToTail = false
    @State private var showFiles = false
    /// A file picked in Files, inserted into the composer as `@path`.
    @State private var mention: ComposerMention?
    private var metadata: ThreadRow? { thread.metadata ?? thread.placeholder?.metadata ?? model.inbox[thread.id] }
    private var screen: ThreadScreenModel { thread.screen }
    /// An archived thread opens read-only (from the archive browser) until it's unarchived.
    private var archived: Bool { model.inbox[thread.id]?.archivedAt != nil }
    var body: some View {
        ScrollViewReader { proxy in
            List {
                if screen.hasOlder {
                    HStack { Spacer(); ProgressView(); Spacer() }
                        .onAppear { model.loadOlder() }
                        .listRowSeparator(.hidden)
                        .accessibilityLabel("Loading earlier messages")
                }
                // Back from a child: what this thread last showed stays until its session's first patch.
                let shown = thread.placeholder ?? thread
                if !thread.loaded && thread.placeholder == nil { ProgressView("Loading conversation…").listRowSeparator(.hidden) }
                let links = TranscriptLinks(openThread: openThread, openAgent: { lane = $0 }, steps: StepsLinks(model: model, screen: screen, epoch: thread.epoch))
                ForEach(shown.screen.blockOrder, id: \.self) { id in
                    if let block = shown.screen.blocks[id] {
                        BlockView(block: block, thread: shown, links: links)
                            .id(id).listRowSeparator(.hidden)
                            .listRowInsets(EdgeInsets(top: AceTheme.Spacing.sm, leading: AceTheme.Spacing.xl, bottom: AceTheme.Spacing.sm, trailing: AceTheme.Spacing.xl))
                    }
                }
                ForEach(model.pending.values.filter { $0.threadId == thread.id && $0.state != "delivered" && thread.items["input:\($0.id)"] == nil }.sorted { $0.id < $1.id }) { row in
                    PendingSendRow(row: row, canRetry: model.canOperate) { await model.retrySend(row) }.listRowSeparator(.hidden)
                }
                Color.clear.frame(height: AceTheme.Dimensions.border).id("tail").listRowSeparator(.hidden).accessibilityHidden(true)
            }
            .listStyle(.plain).scrollContentBackground(.hidden)
            .background(AceTheme.Colours.background)
            .scrollDismissesKeyboard(.interactively)
            .accessibilityIdentifier("transcript")
            .onChange(of: thread.loaded) { _, loaded in
                if loaded && !scrolledToTail { proxy.scrollTo("tail", anchor: .bottom); scrolledToTail = true }
            }
            .onChange(of: ObjectIdentifier(thread)) { scrolledToTail = false }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in
                proxy.scrollTo("tail", anchor: .bottom)
            }
            .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) {
                VStack(spacing: AceTheme.Spacing.none) {
                    // One card at a time above the composer: the oldest open request.
                    if let request = thread.approvals.first {
                        let submission = model.approvalSubmissions[request.id]
                        switch request.kind {
                        case "question":
                            QuestionCard(interaction: request, submission: submission, canAct: model.canOperate) { model.answer(request, answers: $0, dismissed: $1) }
                                .id(request.id)
                        case "plan_review":
                            PlanReviewCard(interaction: request, submission: submission, canAct: model.canOperate) { model.resolve(request, answer: $0) }.id(request.id)
                        case "elicitation":
                            FormRequestCard(interaction: request, submission: submission, canAct: model.canOperate) { model.resolve(request, answer: $0) }.id(request.id)
                        case "browser_help":
                            BrowserHelpCard(interaction: request, submission: submission, canAct: model.canOperate) { model.resolve(request, answer: $0) }.id(request.id)
                        default:
                            ApprovalCard(approval: request, submission: submission, canAct: model.canOperate) { model.approve(request, option: $0) }
                        }
                    }
                    if let queue = screen.queue, !queue.messages.isEmpty {
                        QueueStrip(queue: queue, canAct: model.canOperate,
                                   canSteer: screen.controls?.delivery == "steer" || screen.controls?.alternate == "steer") { message, change in
                            await model.editQueued(message, change: change)
                        }
                    }
                    if archived {
                        ArchivedNote(canOperate: model.canOperate) { await model.unarchive(thread.id) }
                            .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.sm)
                            .floatingGlass()
                            .padding(.horizontal, AceTheme.Dimensions.composerInset).padding(.bottom, AceTheme.Spacing.sm)
                    } else if model.canOperate {
                        ComposerAccessories(model: model, screen: screen)
                        ComposerView(controls: screen.controls, stopping: screen.stopping,
                                     placeholder: thread.approvals.isEmpty ? "Steer or follow up…" : "Reply instead…",
                                     send: { await model.sendMessage($0, alternate: $1) }, stop: { model.stopTree() },
                                     openModels: { showModels = true }, inputBegan: { model.metrics?.inputBegan() }, mention: mention,
                                     files: screen.attachments.count)
                    } else {
                        ViewOnlyNote.thread
                            .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.md)
                            .floatingGlass()
                            .padding(.horizontal, AceTheme.Dimensions.composerInset).padding(.bottom, AceTheme.Spacing.sm)
                    }
                }
            }
            .toolbar {
                ToolbarItem(placement: .principal) { header }
                ToolbarItem(placement: .topBarTrailing) { menu }
            }
            .navigationBarTitleDisplayMode(.inline)
            .threadSheets(model: model, thread: thread, openThread: openThread)
            .sheet(isPresented: $showDetails) { details }
            .sheet(isPresented: $showFiles) {
                ThreadFilesSheet(model: model, scope: .thread(thread.id), mention: model.canOperate ? { mention = ComposerMention(path: $0) } : nil)
                    .presentationDetents([.large]).presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showModels) {
                ModelPickerSheet(screen: screen, load: { model.requestModels() }, choose: { await model.switchModel($0) })
            }
            .sheet(item: $lane) { entry in AgentLaneSheet(entry: entry, model: model, thread: thread, openThread: openThread) }
            #if DEBUG
            .overlay(alignment: .topLeading) {
                if SpikeConfiguration.enabled {
                    Text(verbatim: "\(thread.items.count) items · \(model.connection)").aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                        .padding(AceTheme.Spacing.xs).background(.thinMaterial, in: Capsule()).allowsHitTesting(false)
                        .accessibilityLabel("Loaded transcript").accessibilityValue(String(thread.items.count))
                        .accessibilityIdentifier("spike.loaded")
                }
            }
            #endif
        }
    }
    /// Title, the whole tree's canonical status, and where it runs.
    private var header: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            Text(metadata?.title ?? "Thread").aceFont(AceTheme.Typography.title, relativeTo: .headline).lineLimit(1).minimumScaleFactor(0.7)
            HStack(spacing: AceTheme.Spacing.xs) {
                if let status = metadata?.status { StateLabel(status: status) }
                Text(verbatim: [metadata?.project, metadata?.branch, metadata.map { $0.provider.capitalized }].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                    .aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1).minimumScaleFactor(0.7)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("thread.header")
    }
    private var menu: some View {
        Menu {
            if model.canOperate, screen.controls?.canStop == true {
                Button("Stop all agents", systemImage: "stop.circle", role: .destructive) { model.stopTree() }.disabled(screen.stopping)
            }
            if !model.inboxLayout.snooze.isEmpty {
                Menu("Snooze", systemImage: "moon.zzz") {
                    ForEach(model.inboxLayout.snooze) { option in
                        Button(option.label) { Task { if await model.snooze(thread.id, preset: option.id) { dismiss() } } }
                    }
                }
            }
            if !archived { Button("Archive", systemImage: "archivebox") { Task { if await model.archive(thread.id) { dismiss() } } } }
            Button("Files", systemImage: "folder") { showFiles = true }.accessibilityIdentifier("thread.files")
            Divider()
            Button("Connection details", systemImage: "network") { showDetails = true }
        } label: { Image(systemName: "ellipsis") }
        .accessibilityLabel("Thread options")
        .accessibilityIdentifier("thread.menu")
    }
    private var details: some View {
        NavigationStack {
            Form {
                LabeledContent("Connection", value: model.connection)
                LabeledContent("Items", value: thread.items.count.formatted())
                LabeledContent("Machine", value: metadata?.machine ?? "")
                if let status = metadata?.status { StateLabel(status: status) }
            }
            .navigationTitle("Thread").navigationBarTitleDisplayMode(.inline)
        }.presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
    }
}

/// A message saved on the phone that hasn't reached the transcript yet, from the SDK's state.
private struct PendingSendRow: View {
    let row: PendingRow
    let canRetry: Bool
    let retry: () async -> Bool
    @State private var retrying = false
    var body: some View {
        VStack(alignment: .trailing, spacing: AceTheme.Spacing.xs) {
            Text(row.text).aceFont(AceTheme.Typography.body, relativeTo: .body).padding(AceTheme.Spacing.md)
                .background(AceTheme.Colours.fill, in: RoundedRectangle(cornerRadius: AceTheme.Radii.bubble))
            HStack(spacing: AceTheme.Spacing.sm) {
                Text(row.label ?? status).foregroundStyle(row.token.map(StateStyle.text) ?? (row.state == "failed" ? AceTheme.StatusText.failed : AceTheme.Colours.mutedForeground))
                if row.state == "failed", canRetry {
                    Button {
                        retrying = true
                        Task { _ = await retry(); retrying = false }
                    } label: { Label("Send again", systemImage: "arrow.clockwise") }
                        .disabled(retrying)
                        .accessibilityIdentifier("pending.retry")
                }
            }.aceFont(AceTheme.Typography.caption, relativeTo: .caption)
        }.frame(maxWidth: .infinity, alignment: .trailing)
    }
    private var status: String {
        switch row.state {
        case "failed": "Send needs attention"
        case "accepted": "Accepted"
        case "saving": "Saving on your phone…"
        default: "Sends on reconnect"
        }
    }
}
