import SwiftUI

struct ThreadView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.scenePhase) private var scenePhase
    @Bindable var model: ClientModel
    @Bindable var thread: ThreadModel
    /// Push another thread (a delegated child or a conversation this one started).
    let openThread: (String) -> Void
    @State private var acceptedSend = 0
    @State private var attachProblem: String?
    @State private var showWork = false
    @State private var showDetails = false
    @State private var showModels = false
    @State private var lane: BlockRow.Agents.Entry?
    @State private var showFiles = false
    @State private var media: TranscriptRow?
    @State private var fullMessage: TranscriptRow?
    @State private var showTools = false
    @State private var showComputer = false
    @State private var activityProblem: String?
    @State private var showChanges = false
    @State private var showTerminal = false
    @State private var showBrowser = false
    @State private var showSearch = false
    /// A file picked in Files, inserted into the composer as `@path`.
    @State private var mention: ComposerMention?
    private var metadata: ThreadRow? { thread.metadata ?? thread.placeholder?.metadata ?? model.inbox[thread.id] }
    /// Starting prefers the inbox's current row (confirmed or not, so an unconfirmed start
    /// still reads Syncing); without one it falls back conservatively as unconfirmed.
    private var activityRow: ThreadRow? {
        if let inboxRow = model.inbox[thread.id] { return inboxRow }
        guard var fallback = metadata else { return nil }
        fallback.confirmed = nil
        fallback.generation = nil
        return fallback
    }
    private var screen: ThreadScreenModel { thread.screen }
    /// An archived thread opens read-only (from the archive browser) until it's unarchived.
    private var archived: Bool { (model.inbox[thread.id] ?? metadata)?.archivedAt != nil }
    var body: some View {
        ConversationFeed(model: model, thread: thread, metadata: metadata, acceptedSend: acceptedSend,
                         links: TranscriptLinks(openThread: openThread, openAgent: { lane = $0 }, steps: StepsLinks(model: model, screen: screen, epoch: thread.epoch), openMedia: { media = $0 }, openChanges: { showChanges = true }, openMessage: { fullMessage = $0 }))
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
                            BrowserHelpCard(interaction: request, submission: submission, canAct: model.canOperate,
                                            openBrowser: { showBrowser = true }) { model.resolve(request, answer: $0) }.id(request.id)
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
                        ServiceProblem(message: attachProblem)
                        ComposerView(controls: screen.controls, stopping: screen.stopping,
                                     placeholder: thread.approvals.isEmpty ? "Ask a follow-up" : "Reply instead…",
                                     send: { text, alternate in
                                         let saved = await model.sendMessage(text, alternate: alternate)
                                         if saved { acceptedSend += 1 }
                                         return saved
                                     }, stop: { model.stopTree() },
                                     inputBegan: { model.metrics?.inputBegan() }, mention: mention,
                                     files: screen.attachments.count) {
                            AttachMenu(stage: { model.attach($0) }, problem: $attachProblem)
                        } trailing: {
                            ComposerModelButton(screen: screen, open: { showModels = true })
                        }
                    } else {
                        ViewOnlyNote.thread
                            .padding(.horizontal, AceTheme.Spacing.xl).padding(.vertical, AceTheme.Spacing.md)
                            .background(AceTheme.Colours.background)
                            .overlay(alignment: .top) {
                                Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border)
                            }
                    }
                }
                .background(AceTheme.Colours.background.ignoresSafeArea(edges: .bottom))
            }
            .toolbar { chatToolbar }
            .toolbarBackground(AceTheme.Colours.background, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .safeAreaInset(edge: .top, spacing: AceTheme.Spacing.none) {
                if typeSize.isAccessibilitySize, let status = metadata?.status {
                    StateLabel(status: status)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, AceTheme.Spacing.xl).padding(.vertical, AceTheme.Spacing.sm)
                        .background(AceTheme.Colours.background)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .threadSheets(model: model, thread: thread, openThread: openThread, work: $showWork, changes: $showChanges, terminal: $showTerminal)
            .sheet(isPresented: $showDetails) { details }
            .alert("Live Activity", isPresented: Binding(get: { activityProblem != nil }, set: { if !$0 { activityProblem = nil } })) {
                Button("OK") { activityProblem = nil }
            } message: { Text(activityProblem ?? "") }
            .sheet(isPresented: $showComputer) { NavigationStack { RemoteScreenView(model: model, threadId: thread.id) } }
            .sheet(isPresented: $showTools) {
                NavigationStack { ThreadToolsView(model: model, thread: thread, openThread: openThread) }.presentationDetents([.large]).presentationDragIndicator(.visible)
            }
            .sheet(item: $fullMessage) { item in FullMessageView(model: model, threadId: thread.id, item: item) }
            .sheet(item: $media) { item in
                NavigationStack { NativeMediaView(model: model, threadId: thread.id, item: item) }.presentationDetents([.large]).presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showSearch) {
                NavigationStack { ConversationSearchView(model: model, threadId: thread.id, openThread: { id in showSearch = false; openThread(id) }) }
            }
            .sheet(isPresented: $showFiles) {
                ThreadFilesSheet(model: model, scope: .thread(thread.id), mention: model.canOperate ? { mention = ComposerMention(path: $0) } : nil)
                    .presentationDetents([.large]).presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showModels) {
                ModelPickerSheet(screen: screen, load: { model.requestModels() }, choose: { await model.switchModel($0) }, tuning: {
                    if let tune = screen.tune, !tune.efforts.isEmpty || !tune.speeds.isEmpty { TuneChip(tune: tune, model: model) }
                })
            }
            .sheet(item: $lane) { entry in AgentLaneSheet(entry: entry, model: model, thread: thread, openThread: openThread) }
            // The agent may open its browser after the thread was opened: ask again as it works.
            .onChange(of: metadata?.state) { model.probeBrowser() }
            // A browser opened mid-turn leaves the state unchanged: follow it, bounded, while this
            // thread is on screen, working and the app is active. Leaving cancels the follow.
            .task(id: browserFollow) { if browserFollow != nil { await model.followBrowser() } }
            .fullScreenCover(isPresented: $showBrowser) {
                let help = thread.approvals.first { $0.kind == "browser_help" }
                BrowserLiveView(model: model, help: help) { answer in if let help { model.resolve(help, answer: answer) } }
            }
            #if DEBUG
            .overlay(alignment: .topLeading) {
                if SpikeConfiguration.enabled && ProcessInfo.processInfo.arguments.contains("--spike-metrics") {
                    Text(verbatim: "\(thread.items.count) items · \(model.connection)").aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                        .padding(AceTheme.Spacing.xs).background(.thinMaterial, in: Capsule()).allowsHitTesting(false)
                        .accessibilityLabel("Loaded transcript").accessibilityValue(String(thread.items.count))
                        .accessibilityIdentifier("spike.loaded")
                }
            }
            #endif
    }
    /// Restarts the browser follow on a new visit, a new turn or a return to the foreground.
    private var browserFollow: Int? {
        guard scenePhase == .active, screen.controls?.busy == true, !model.threadHasBrowser else { return nil }
        return thread.epoch
    }
    /// The browser's compact title; canonical state and workspace details are in Work.
    @ToolbarContentBuilder private var chatToolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) { header }
        if #available(iOS 26, *) {
            ToolbarItem(placement: .topBarTrailing) { menu }.sharedBackgroundVisibility(.hidden)
            ToolbarItem(placement: .topBarTrailing) { workButton }.sharedBackgroundVisibility(.hidden)
            ToolbarItem(placement: .topBarTrailing) { panel }.sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .topBarTrailing) { menu }
            ToolbarItem(placement: .topBarTrailing) { workButton }
            ToolbarItem(placement: .topBarTrailing) { panel }
        }
    }
    private var workButton: some View {
        Button { showWork = true } label: { Image(systemName: "laptopcomputer").imageScale(.small) }
            .accessibilityLabel("Work").accessibilityIdentifier("thread.work")
    }
    private var header: some View {
        Text(metadata?.title ?? "Thread").aceFont(AceTheme.Typography.rowTitle, relativeTo: .headline).lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityValue(metadata?.status.label ?? "")
            .accessibilityIdentifier("thread.header")
    }
    private var panel: some View {
        Menu {
            Button("Files", systemImage: "folder") { showFiles = true }
            Button("Terminal", systemImage: "terminal") { showTerminal = true }
            if model.threadHasBrowser { Button("Browser", systemImage: "safari") { showBrowser = true } }
            Button("Computer use", systemImage: "macwindow") { showComputer = true }
            Button("Skills and tools", systemImage: "wrench.and.screwdriver") { showTools = true }
        } label: { Image(systemName: "sidebar.right").imageScale(.small) }
        .accessibilityLabel("Right panel").accessibilityIdentifier("thread.panel")
    }
    private var menu: some View {
        Menu {
            Button("Search conversation", systemImage: "magnifyingglass") { showSearch = true }
            Button("Changes", systemImage: "plusminus") { showChanges = true }.accessibilityIdentifier("thread.changes")
            Button("Terminal", systemImage: "terminal") { showTerminal = true }.accessibilityIdentifier("thread.terminal")
            Button("Files", systemImage: "folder") { showFiles = true }.accessibilityIdentifier("thread.files")
            Button("Thread tools", systemImage: "wrench.and.screwdriver") { showTools = true }.accessibilityIdentifier("thread.tools")
            Divider()
            if let activityRow, let hostId = model.hostId {
                Button("Show on Lock Screen", systemImage: "widget.small") {
                    do { try model.liveActivity.start(row: activityRow, hostId: hostId, online: model.connection == "ready") }
                    catch { activityProblem = error.localizedDescription }
                }
            }
            if model.canOperate, screen.controls?.canStop == true {
                Button("Stop all agents", systemImage: "stop.circle", role: .destructive) { model.stopTree() }.disabled(screen.stopping)
            }
            if model.canOperate, !model.inboxLayout.snooze.isEmpty {
                Menu("Snooze", systemImage: "moon.zzz") {
                    ForEach(model.inboxLayout.snooze) { option in
                        Button(option.label) { Task { if await model.snooze(thread.id, preset: option.id) { dismiss() } } }
                    }
                }
            }
            if model.canOperate, !archived { Button("Archive", systemImage: "archivebox") { Task { if await model.archive(thread.id) { dismiss() } } } }
            if model.threadHasBrowser {
                Button("Browser", systemImage: "safari") { showBrowser = true }.accessibilityIdentifier("thread.browser")
            }
            Divider()
            Button("Connection details", systemImage: "network") { showDetails = true }
        } label: { Image(systemName: "ellipsis").imageScale(.small) }
        .accessibilityLabel("Thread options")
        .accessibilityIdentifier("thread.menu")
    }
    private var details: some View {
        NavigationStack {
            Form {
                LabeledContent("Title", value: metadata?.title ?? "Thread")
                LabeledContent("Project", value: metadata?.project ?? "")
                LabeledContent("Branch", value: metadata?.branch ?? "")
                LabeledContent("Agent", value: metadata?.provider.capitalized ?? "")
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
struct PendingSendRow: View {
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
