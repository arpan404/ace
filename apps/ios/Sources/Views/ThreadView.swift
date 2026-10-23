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
    @State private var showTune = false
    @State private var lane: BlockRow.Agents.Entry?
    @State private var showFiles = false
    @State private var media: TranscriptRow?
    @State private var fullMessage: TranscriptRow?
    @State private var showTools = false
    @State private var showComputer = false
    @State private var devicesRoute: DevicesRoute?
    @State private var activityProblem: String?
    @State private var showAgents = false
    @State private var showChanges = false
    @State private var showTerminal = false
    @State private var showBrowser = false
    @State private var showSearch = false
    @State private var showQueue = false
    @State private var showGoal = false
    /// The navigation generation the goal's sheet was opened on: its changes are for that one.
    @State private var goalEpoch = 0
    /// The person reads away from the live end: Scroll to end floats beside the pill.
    @State private var behind = false
    /// Each Scroll to end the person taps.
    @State private var jumps = 0
    /// The question card's picks and page, kept here so a reply typed below keeps them.
    @State private var questionDraft = QuestionDraftState()
    @State private var height: CGFloat = 0
    @State private var barHeight: CGFloat = 0
    /// A file picked in Files, inserted into the composer as `@path`.
    @State private var mention: ComposerMention?
    private var metadata: ThreadRow? { thread.metadata ?? model.inbox[thread.id] }
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
    /// The question on the strip, whose card the composer's words may answer.
    private var asking: ApprovalRow? {
        guard let request = thread.approvals.first, request.kind == "question" else { return nil }
        return request
    }
    private var subtitle: String {
        guard let metadata else { return "" }
        let place = metadata.branch.isEmpty ? metadata.machine : metadata.branch
        return [metadata.project, place].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    var body: some View {
        ConversationFeed(model: model, thread: thread, acceptedSend: acceptedSend,
                         links: TranscriptLinks(openThread: openThread, openAgent: { lane = $0 }, steps: StepsLinks(model: model, screen: thread.screen, epoch: thread.epoch),
                                                openMedia: { media = $0 }, openChanges: { showChanges = true }, openMessage: { fullMessage = $0 },
                                                openAgents: { showAgents = true }, threadStatus: { model.inbox[$0]?.status }),
                         barHeight: barHeight, behind: $behind, jumps: jumps)
            .modifier(FloatingBar(height: $barHeight) { bottomBar })
            // The height under the bar, steady while the keyboard or a card changes the insets.
            .background {
                Color.clear.ignoresSafeArea()
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
            }
            .toolbar {
                ThreadToolbar(title: metadata?.title ?? "Thread", project: metadata?.project ?? "", badge: metadata?.badge, status: model.headerStatus(of: thread),
                              menu: ThreadMenu(model: model, thread: thread, archived: archived, activityRow: activityRow,
                                               open: open, problem: { activityProblem = $0 }, leave: { dismiss() }))
            }
            .navigationTitle(metadata?.title ?? "Thread")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .top, spacing: AceTheme.Spacing.none) {
                if typeSize.isAccessibilitySize, let status = model.headerStatus(of: thread) {
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
            .environment(\.openStep) { opens in
                if opens == "computer" { showComputer = true } else if opens.hasPrefix("device:") { devicesRoute = .device(String(opens.dropFirst(7))) }
            }
            .navigationDestination(item: $devicesRoute) { route in DevicesRouteView(model: model, threadId: thread.id, route: route) }
            .navigationDestination(isPresented: $showComputer) { RemoteScreenView(model: model, threadId: thread.id) }
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
            .modifier(ThreadFileRoutes(model: model, threadId: thread.id, subtitle: subtitle, showFiles: $showFiles,
                                       mention: model.canOperate ? { mention = ComposerMention(path: $0) } : nil))
            .sheet(isPresented: $showModels) {
                ModelPickerSheet(model: model, screen: screen)
            }
            .sheet(isPresented: $showTune) {
                if let tune = screen.tune { ThreadTunePanel(tune: tune, model: model) }
            }
            .sheet(item: $lane) { entry in AgentLaneSheet(entry: entry, model: model, thread: thread, openThread: openThread) }
            .sheet(isPresented: $showGoal) {
                if let goal = screen.goal {
                    GoalSheet(goal: goal, canOperate: model.canOperate) { [goalEpoch] change in await model.changeGoal(change, epoch: goalEpoch) }
                }
            }
            .sheet(isPresented: $showQueue) {
                if let queue = screen.queue {
                    QueueSheet(queue: queue, canAct: model.canOperate,
                               canSteer: screen.controls?.delivery == "steer" || screen.controls?.alternate == "steer") { message, change in
                        await model.editQueued(message, change: change)
                    }
                }
            }
            // A sheet whose subject went away closes.
            .onChange(of: screen.goal == nil) { _, gone in if gone { showGoal = false } }
            .onChange(of: screen.queue?.messages.isEmpty ?? true) { _, gone in if gone { showQueue = false } }
            // The agent may open its browser after the thread was opened: ask again as it works.
            .onChange(of: metadata?.state) { model.probeBrowser() }
            // A browser opened mid-turn leaves the state unchanged: follow it, bounded, while this
            // thread is on screen, working and the app is active. Leaving cancels the follow.
            .task(id: browserFollow) { if browserFollow != nil { await model.followBrowser() } }
            .navigationDestination(isPresented: $showBrowser) {
                let help = thread.approvals.first { $0.kind == "browser_help" }
                BrowserScreen(model: model, help: help) { answer in if let help { model.resolve(help, answer: answer) } }
            }
            .environment(\.openBrowser, { showBrowser = true })
            .environment(\.stopBackground, model.canOperate ? { id in Task { _ = await model.stopTask(id) } } : nil)
            #if ACE_FIXTURE
            .overlay(alignment: .topLeading) {
                if SpikeConfiguration.enabled && ProcessInfo.processInfo.arguments.contains("--spike-metrics") {
                    Text(verbatim: "\(thread.items.count) items · \(model.connection)").aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                        .padding(AceTheme.Spacing.xs).background(.thinMaterial, in: AceShape.capsule).allowsHitTesting(false)
                        .accessibilityLabel("Loaded transcript").accessibilityValue(String(thread.items.count))
                        .accessibilityIdentifier("spike.loaded")
                }
            }
            #endif
    }

    /// The composer with what floats above it: the live pill and Scroll to end, and the one strip
    /// tucked under the composer's top edge, which holds the oldest open request (a question
    /// too, the composer staying under it). While a request needs the person the pill steps
    /// aside. Nothing renders below the composer.
    @ViewBuilder private var bottomBar: some View {
        let request = thread.approvals.first
        VStack(spacing: AceTheme.Spacing.none) {
            // Whether a request takes the pill's place is the bridge's (`livePill`).
            ComposerFloaters(pill: screen.pill, behind: behind, open: openPill) { jumps += 1 }
                .padding(.bottom, AceTheme.Spacing.sm)
            // The strip and the composer are one glass.
            VStack(spacing: AceTheme.Spacing.none) {
                Group {
                    if let request { StripSurface(maxHeight: height * 0.6) { requestCard(request) } }
                }
                .transition(.opacity)
                if archived {
                    ArchivedNote(canOperate: model.canOperate) { await model.unarchive(thread.id) }
                        .modifier(ComposerFrame(padding: EdgeInsets(top: AceTheme.Spacing.sm, leading: AceTheme.Spacing.lg, bottom: AceTheme.Spacing.sm, trailing: AceTheme.Spacing.lg)))
                } else if model.canOperate {
                    ComposerView(controls: screen.controls, stopping: screen.stopping, placeholder: asking == nil ? placeholder : "Reply…",
                                 send: { text, alternate in
                                     let reply = asking.map { QuestionReply(interactionId: $0.id, draft: questionDraft) }
                                     let saved = await model.sendMessage(text, alternate: alternate, reply: reply)
                                     if saved { acceptedSend += 1 }
                                     return saved
                                 }, stop: { model.stopTree() },
                                 inputBegan: { model.metrics?.inputBegan() }, mention: mention,
                                 files: screen.attachments.count,
                                 draftKey: model.hostId.map { ThreadDrafts.key(hostId: $0, threadId: thread.id) }) {
                        ComposerAccessories(model: model, screen: screen, problem: attachProblem)
                    } leading: {
                        HStack(spacing: AceTheme.Spacing.none) {
                            AttachMenu(stage: { model.attach($0) }, problem: $attachProblem)
                                .foregroundStyle(AceTheme.Colours.mutedForeground)
                            ThreadAccessChip(access: screen.access) { mode in Task { _ = await model.setAccess(mode) } }
                        }
                    } trailing: {
                        ComposerModelButton(screen: screen, open: { showModels = true }, openTune: { showTune = true })
                    }
                } else {
                    ViewOnlyNote.thread
                        .modifier(ComposerFrame(padding: EdgeInsets(top: AceTheme.Spacing.md, leading: AceTheme.Spacing.lg, bottom: AceTheme.Spacing.md, trailing: AceTheme.Spacing.lg)))
                }
            }
            .composerGlassGroup()
        }
        .animation(reduceMotion ? nil : AceTheme.Motion.standardCurve, value: request?.id)
        .onChange(of: request?.id) { _, _ in questionDraft = QuestionDraftState() }
    }
    /// A pill part opens what it names.
    private func openPill(_ opens: String) {
        switch opens {
        case "agents": showAgents = true
        case "queue": showQueue = true
        case "goal": goalEpoch = thread.epoch; showGoal = true
        default: break
        }
    }
    @ViewBuilder private func requestCard(_ request: ApprovalRow) -> some View {
        let submission = model.approvalSubmissions[request.id]
        switch request.kind {
        case "question":
            QuestionCard(interaction: request, submission: submission, canAct: model.canOperate, maxHeight: height * 0.6, draft: $questionDraft) {
                model.answer(request, answers: $0, dismissed: $1)
            }.id(request.id)
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
    /// The composer always reads the same; how a message goes while the agent works is the send
    /// button's to say.
    private let placeholder = "Ask anything"
    private func open(_ destination: ThreadDestination) {
        switch destination {
        case .changes: showChanges = true
        case .search: showSearch = true
        case .files: showFiles = true
        case .terminal: showTerminal = true
        case .browser: showBrowser = true
        case .devices: devicesRoute = .list
        case .computer: showComputer = true
        case .tools: showTools = true
        case .agents: showAgents = true
        }
    }
    /// Restarts the browser follow on a new visit, a new turn or a return to the foreground.
    private var browserFollow: Int? {
        guard scenePhase == .active, screen.controls?.busy == true, !model.threadHasBrowser else { return nil }
        return thread.epoch
    }
}

/// The composer floats over the feed and rides the keyboard, while the feed keeps its size under
/// the keyboard and makes room for the bar, strip included, at its end. The transcript scrolls on
/// behind the composer's glass and shows through it; below the composer's lower edge the page is
/// solid, so words never show in the gap above the keyboard or behind the home indicator.
private struct FloatingBar<Bar: View>: ViewModifier {
    @Binding var height: CGFloat
    @ViewBuilder let bar: () -> Bar
    func body(content: Content) -> some View {
        ZStack(alignment: .bottom) {
            content.ignoresSafeArea(.keyboard, edges: .bottom)
            bar()
                .background(alignment: .bottom) { BarFloor() }
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        }
    }
}

/// The page colour from the composer's lower edge on down, behind the keyboard's translucent
/// edge and the home indicator, and into the composer's rounded lower corners so no word shows
/// beside them. The composer sits `sm` above the bar's bottom and `md` in from each side
/// (`ComposerFrame`).
private struct BarFloor: View {
    private let below = AceTheme.Dimensions.touchTarget * 8
    private let radius = AceTheme.Radii.composer
    var body: some View {
        GeometryReader { box in
            let top = AceTheme.Spacing.sm + radius
            Path { path in
                path.addRect(CGRect(x: 0, y: 0, width: box.size.width, height: top + below))
                // The composer's lower edge, drawn taller so only its bottom corners cut in.
                let composer = CGRect(x: AceTheme.Spacing.md, y: -radius, width: box.size.width - AceTheme.Spacing.md * 2, height: radius * 2)
                path.addRoundedRect(in: composer, cornerSize: CGSize(width: radius, height: radius), style: .continuous)
            }
            .fill(AceTheme.Colours.background, style: FillStyle(eoFill: true))
        }
        .frame(height: AceTheme.Spacing.sm + radius + below)
        .offset(y: below)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
