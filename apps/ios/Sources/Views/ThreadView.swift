import SwiftUI

struct ThreadView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Bindable var model: ClientModel
    @Bindable var thread: ThreadModel
    /// Push another thread (a delegated child or a conversation this one started).
    let openThread: (String) -> Void
    @State private var acceptedSend = 0
    @State private var attachProblem: String?
    @State private var showModels = false
    @State private var lane: BlockRow.Agents.Entry?
    @State private var showFiles = false
    @State private var media: TranscriptRow?
    @State private var fullMessage: TranscriptRow?
    @State private var showTools = false
    @State private var showComputer = false
    @State private var activityProblem: String?
    @State private var showAgents = false
    @State private var showChanges = false
    @State private var showTerminal = false
    @State private var showBrowser = false
    @State private var showSearch = false
    @State private var showQueue = false
    @State private var height: CGFloat = 0
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
    private var queued: Int { screen.queue?.messages.count ?? 0 }
    /// The live state floats above the composer unless a request has the person's attention.
    private var capsuleShown: Bool { thread.approvals.isEmpty && (screen.activity != nil || queued > 0) }
    private var subtitle: String {
        guard let metadata else { return "" }
        let place = metadata.branch.isEmpty ? metadata.machine : metadata.branch
        return [metadata.project, place].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    var body: some View {
        ConversationFeed(model: model, thread: thread, acceptedSend: acceptedSend,
                         links: TranscriptLinks(openThread: openThread, openAgent: { lane = $0 }, steps: StepsLinks(model: model, screen: screen, epoch: thread.epoch),
                                                openMedia: { media = $0 }, openChanges: { showChanges = true }, openMessage: { fullMessage = $0 },
                                                openAgents: { showAgents = true }))
            .overlay(alignment: .bottom) {
                if capsuleShown {
                    LiveCapsule(activity: screen.activity, queued: queued, stopping: screen.stopping) { showQueue.toggle() }
                        .padding(.horizontal, AceTheme.Dimensions.touchTarget + AceTheme.Spacing.xl)
                        .padding(.bottom, AceTheme.Spacing.md)
                        .transition(.opacity)
                }
            }
            .animation(reduceMotion ? nil : AceTheme.Motion.standardCurve, value: capsuleShown)
            .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) { bottomBar }
            // The height under the bar, steady while the keyboard or a card changes the insets.
            .background {
                Color.clear.ignoresSafeArea()
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
            }
            .toolbar {
                ThreadToolbar(title: metadata?.title ?? "Thread", subtitle: subtitle, status: metadata?.status.label ?? "",
                              openChanges: { showChanges = true }, openAgents: { showAgents = true },
                              menu: ThreadMenu(model: model, thread: thread, archived: archived, activityRow: activityRow,
                                               open: open, problem: { activityProblem = $0 }, leave: { dismiss() }))
            }
            .threadTitle(metadata?.title ?? "Thread", subtitle: subtitle)
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .top, spacing: AceTheme.Spacing.none) {
                if typeSize.isAccessibilitySize, let status = metadata?.status {
                    StateLabel(status: status)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, AceTheme.Spacing.xl).padding(.vertical, AceTheme.Spacing.sm)
                        .background(AceTheme.Colours.background)
                }
            }
            .threadSheets(model: model, thread: thread, openThread: openThread, agents: $showAgents, changes: $showChanges, terminal: $showTerminal)
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
                ModelPickerSheet(model: model, screen: screen)
            }
            .sheet(item: $lane) { entry in AgentLaneSheet(entry: entry, model: model, thread: thread, openThread: openThread) }
            // The agent may open its browser after the thread was opened: ask again as it works.
            .onChange(of: metadata?.state) { model.probeBrowser() }
            // A browser opened mid-turn leaves the state unchanged: follow it, bounded, while this
            // thread is on screen, working and the app is active. Leaving cancels the follow.
            .task(id: browserFollow) { if browserFollow != nil { await model.followBrowser() } }
            .onChange(of: queued) { _, count in if count == 0 { showQueue = false } }
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

    /// Above the composer: the oldest open request (a question takes the composer's place), the
    /// queued messages when the capsule opened them, then the composer.
    @ViewBuilder private var bottomBar: some View {
        let request = thread.approvals.first
        VStack(spacing: AceTheme.Spacing.none) {
            if let request, request.kind != "question" { requestCard(request) }
            if showQueue, let queue = screen.queue, !queue.messages.isEmpty {
                QueueStrip(queue: queue, canAct: model.canOperate,
                           canSteer: screen.controls?.delivery == "steer" || screen.controls?.alternate == "steer") { message, change in
                    await model.editQueued(message, change: change)
                }
                .transition(.opacity)
            }
            if archived {
                ArchivedNote(canOperate: model.canOperate) { await model.unarchive(thread.id) }
                    .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.sm)
                    .floatingGlass()
                    .padding(.horizontal, AceTheme.Spacing.md).padding(.bottom, AceTheme.Spacing.sm)
            } else if let request, request.kind == "question" {
                QuestionCard(interaction: request, submission: model.approvalSubmissions[request.id], canAct: model.canOperate, maxHeight: height * 0.6) {
                    model.answer(request, answers: $0, dismissed: $1)
                }
                .id(request.id)
            } else if model.canOperate {
                ComposerAccessories(model: model, screen: screen)
                ServiceProblem(message: attachProblem)
                ComposerView(controls: screen.controls, stopping: screen.stopping, placeholder: placeholder,
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
                    .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.md)
                    .floatingGlass()
                    .padding(.horizontal, AceTheme.Spacing.md).padding(.bottom, AceTheme.Spacing.sm)
            }
        }
        .animation(reduceMotion ? nil : AceTheme.Motion.standardCurve, value: showQueue)
    }
    @ViewBuilder private func requestCard(_ request: ApprovalRow) -> some View {
        let submission = model.approvalSubmissions[request.id]
        switch request.kind {
        case "plan_review":
            PlanReviewCard(interaction: request, submission: submission, canAct: model.canOperate) { model.resolve(request, answer: $0) }.id(request.id)
        case "elicitation":
            FormRequestCard(interaction: request, submission: submission, canAct: model.canOperate) { model.resolve(request, answer: $0) }.id(request.id)
        case "browser_help":
            BrowserHelpCard(interaction: request, submission: submission, canAct: model.canOperate,
                            openBrowser: { showBrowser = true }) { model.resolve(request, answer: $0) }.id(request.id)
        default:
            ApprovalCard(approval: request, submission: submission, canAct: model.canOperate) { model.approve(request, option: $0) }.id(request.id)
        }
    }
    private var placeholder: String {
        if !thread.approvals.isEmpty { return "Reply instead" }
        guard screen.controls?.busy == true else { return "Message" }
        if screen.controls?.alternate != nil { return "Steer or queue a message" }
        return screen.controls?.delivery == "steer" ? "Steer the agent" : "Queue a message"
    }
    private func open(_ destination: ThreadDestination) {
        switch destination {
        case .search: showSearch = true
        case .files: showFiles = true
        case .terminal: showTerminal = true
        case .browser: showBrowser = true
        case .computer: showComputer = true
        case .tools: showTools = true
        }
    }
    /// Restarts the browser follow on a new visit, a new turn or a return to the foreground.
    private var browserFollow: Int? {
        guard scenePhase == .active, screen.controls?.busy == true, !model.threadHasBrowser else { return nil }
        return thread.epoch
    }
}
