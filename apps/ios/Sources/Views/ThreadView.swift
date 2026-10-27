import SwiftUI

struct ThreadView: View {
    @Environment(\.dismiss) private var dismiss
    /// Closes the thread open beside the list, which has no page under it to go back to.
    @Environment(\.closeOpenThread) private var closeOpenThread
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
    /// The composer's settings sheet, and what it hands on to once it closes.
    @State private var showSettings = false
    @State private var afterSettings: (() -> Void)?
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
    @State private var showLogs = false
    @State private var showOffshift = false
    @State private var showSearch = false
    @State private var showQueue = false
    /// The goal's sheet, named by the navigation generation it was opened on: its changes are for
    /// that one. The generation rides on the presentation itself, since a sheet keeps the content
    /// it was first built with and a value captured beside it would be the one before opening.
    @State private var goalSheet: GoalPresentation?
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
    /// The composer's `@`, `/` and + lists.
    @State private var suggester = ComposerSuggester()
    /// "Attach files" picked from `/`: the + menu's three sources are offered.
    @State private var askAttach = false
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
    /// The question above the composer, whose card the composer's words may answer.
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
                                                openMedia: { media = $0 }, openChanges: { showChanges = true }, openMessage: { DisclosureTrace.shared.asked("message", key: $0.id); fullMessage = $0 },
                                                openAgents: { showAgents = true }, threadStatus: { model.inbox[$0]?.status },
                                                threadTitle: { model.inbox[$0]?.title }),
                         barHeight: barHeight, behind: $behind, jumps: jumps)
            .publishedMedia(model: model, threadId: thread.id)
            .modifier(FloatingBar(height: $barHeight) { bottomBar })
            // The height under the bar, steady while the keyboard or a card changes the insets.
            .background {
                Color.clear.ignoresSafeArea()
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
            }
            .toolbar {
                ThreadToolbar(title: metadata?.title ?? "Thread", subtitle: subtitle, status: model.headerStatus(of: thread),
                              menu: ThreadMenu(model: model, thread: thread, title: metadata?.title ?? "", archived: archived, activityRow: activityRow,
                                               open: open, problem: { activityProblem = $0 }, leave: leave))
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
            .threadSheets(model: model, thread: thread, openThread: openThread, agents: $showAgents, changes: $showChanges, terminal: $showTerminal, logs: $showLogs)
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
                NavigationStack { ConversationSearchView(model: model, threadId: thread.id, openThread: { id in showSearch = false; if id != thread.id { openThread(id) } }) }
            }
            .modifier(MessageAttachmentRoutes(model: model, threadId: thread.id))
            .modifier(ThreadFileRoutes(model: model, threadId: thread.id, subtitle: subtitle, showFiles: $showFiles,
                                       mention: model.canOperate ? { mention = ComposerMention(path: $0) } : nil))
            .sheet(isPresented: $showSettings, onDismiss: { afterSettings?(); afterSettings = nil }) {
                ComposerSettingsSheet(screen: screen,
                                      openModel: { afterSettings = { showModels = true }; showSettings = false },
                                      openTune: { afterSettings = { showTune = true }; showSettings = false },
                                      setAccess: { mode in Task { _ = await model.setAccess(mode) } })
            }
            .sheet(isPresented: $showModels) {
                ModelPickerSheet(model: model, screen: screen)
            }
            .sheet(isPresented: $showTune) {
                if let tune = screen.tune { ThreadTunePanel(tune: tune, model: model) }
            }
            .sheet(isPresented: $showOffshift) {
                NavigationStack {
                    OffshiftRunView(screen: thread.screen)
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showOffshift = false } } }
                }
                .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
            }
            .sheet(item: $lane) { entry in AgentLaneSheet(entry: entry, model: model, thread: thread, openThread: openThread) }
            .transferSheet(model: model, kind: "thread")
            .sheet(item: $goalSheet) { opened in
                if let goal = screen.goal {
                    GoalSheet(goal: goal, canOperate: model.canOperate) { change in await model.changeGoal(change, epoch: opened.epoch) }
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
            // The next message continued this thread in a new one: open it once its row is here
            // (ten seconds at most; after that it's in the list to tap).
            .task(id: screen.continued) {
                guard let opened = screen.continued else { return }
                for _ in 0..<100 where model.inbox[opened] == nil {
                    try? await Task.sleep(for: .milliseconds(100))
                    if Task.isCancelled { return }
                }
                screen.continued = nil
                if model.inbox[opened] != nil { openThread(opened) }
            }
            // A sheet whose subject went away closes.
            .onChange(of: screen.goal == nil) { _, gone in if gone { goalSheet = nil } }
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

    /// The composer with what floats above it: the live pill and Scroll to end, and the grouped
    /// surface just above the composer, which holds the oldest open request (a question
    /// too, the composer staying under it). While a request needs the person the pill steps
    /// aside. Nothing sits below the composer.
    @ViewBuilder private var bottomBar: some View {
        let request = thread.approvals.first
        VStack(spacing: AceTheme.Spacing.none) {
            // Whether a request takes the pill's place is the bridge's (`livePill`).
            ComposerFloaters(pill: screen.pill, behind: behind, open: openPill) { jumps += 1 }
                .padding(.bottom, AceTheme.Spacing.sm)
            VStack(spacing: AceTheme.Spacing.none) {
                Group {
                    if let request { StripSurface(maxHeight: height * 0.6) { requestCard(request) } }
                    // A request needs the person first; the transfer's line waits under it.
                    else if let line = model.transfers.thread(thread.id)?.line { ThreadTransferStrip(model: model, line: line) }
                }
                .transition(.opacity)
                if archived {
                    ArchivedNote(canOperate: model.canOperate) { await model.unarchive(thread.id) }
                        .modifier(ComposerFrame(padding: EdgeInsets(top: AceTheme.Spacing.sm, leading: AceTheme.Spacing.lg, bottom: AceTheme.Spacing.sm, trailing: AceTheme.Spacing.lg)))
                } else if model.canOperate {
                    ComposerView(controls: screen.controls, stopping: screen.stopping, placeholder: asking == nil ? placeholder : "Reply…",
                                 send: { text, alternate, references in
                                     let reply = asking.map { QuestionReply(interactionId: $0.id, draft: questionDraft) }
                                     let saved = await model.sendMessage(text, alternate: alternate, reply: reply, references: references)
                                     if saved { acceptedSend += 1 }
                                     return saved
                                 }, stop: { model.stopTree() },
                                 inputBegan: { model.metrics?.inputBegan() }, mention: mention,
                                 files: screen.attachments.count,
                                 draftKey: model.hostId.map { ThreadDrafts.key(hostId: $0, threadId: thread.id) },
                                 suggester: suggester, suggestionHeight: max(AceTheme.Dimensions.touchTarget * 2, height * (request == nil ? 0.4 : 0.22)),
                                 run: runComposerAction) {
                        ComposerAccessories(model: model, screen: screen, problem: attachProblem)
                    } leading: { pick in
                        AttachMenu(stage: { model.attach($0) }, problem: $attachProblem, more: suggester.adding, pickMore: pick, ask: $askAttach)
                            .foregroundStyle(AceTheme.Colours.foreground)
                    } access: {
                        ThreadAccessChip(access: screen.access) { mode in Task { _ = await model.setAccess(mode) } }
                    } model: {
                        ComposerModelButton(screen: screen, open: { showModels = true }, openTune: { showTune = true })
                    } settings: {
                        Button { showSettings = true } label: {
                            Image(systemName: "slider.horizontal.3").font(.system(size: 15, weight: .medium))
                                .foregroundStyle(AceTheme.Colours.foreground)
                                .frame(maxWidth: .infinity, maxHeight: .infinity).contentShape(Circle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Model and access").accessibilityIdentifier("composer.settings")
                    }
                    .task(id: thread.id) {
                        suggester.attach(model)
                        suggester.scope = .thread(thread.id)
                        suggester.readAhead()
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
    /// Archiving or snoozing leaves the thread: back a page, or closed when it is the open one.
    private func leave() {
        if let close = closeOpenThread, close.id == thread.id { close.close() } else { dismiss() }
    }
    /// A pill part opens what it names.
    private func openPill(_ opens: String) {
        switch opens {
        case "agents": showAgents = true
        case "queue": showQueue = true
        case "goal": goalSheet = GoalPresentation(epoch: thread.epoch)
        default: break
        }
    }
    private func requestCard(_ request: ApprovalRow) -> some View {
        RequestCard(request: request, model: model, maxHeight: height * 0.6, questionDraft: $questionDraft, openBrowser: { showBrowser = true })
    }
    /// A builtin from the composer's `/` or + list (the bridge lists only these on a thread).
    private func runComposerAction(_ action: String) {
        switch action {
        case "attach": askAttach = true
        case "plan": Task { _ = await model.setAccess("read-only") }
        case "model": showModels = true
        case "review": showChanges = true
        default: break
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
        case .logs: showLogs = true
        case .offshift: showOffshift = true
        }
    }
    /// Restarts the browser follow on a new visit, a new turn or a return to the foreground.
    private var browserFollow: Int? {
        guard scenePhase == .active, screen.controls?.busy == true, !model.threadHasBrowser else { return nil }
        return thread.epoch
    }
}

/// The goal's sheet as presented: the navigation generation it belongs to.
private struct GoalPresentation: Identifiable {
    let epoch: Int
    var id: Int { epoch }
}

/// The composer floats over the feed and rides the keyboard, while the feed keeps its size under
/// the keyboard and makes room for the bar, request included, at its end. The transcript scrolls
/// on behind the composer's glass; from the composer's lower edge on down the page is solid, so
/// words never show in the gap above the keyboard or behind the home indicator.
private struct FloatingBar<Bar: View>: ViewModifier {
    @Binding var height: CGFloat
    @ViewBuilder let bar: () -> Bar
    func body(content: Content) -> some View {
        ZStack(alignment: .bottom) {
            content.ignoresSafeArea(.keyboard, edges: .bottom)
            // The composer keeps the transcript's reading width; its floor spans the window.
            bar()
                .frame(maxWidth: ReadingColumn.maxWidth)
                .frame(maxWidth: .infinity)
                .background(alignment: .bottom) { BarFloor() }
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        }
    }
}

/// The page colour from the composer's lower edge on down, behind the keyboard's translucent
/// edge and the home indicator. The composer itself stays glass over the transcript.
private struct BarFloor: View {
    private let below = AceTheme.Dimensions.touchTarget * 8
    private let fade = AceTheme.Spacing.lg
    var body: some View {
        VStack(spacing: AceTheme.Spacing.none) {
            LinearGradient(colors: [AceTheme.Colours.background.opacity(0), AceTheme.Colours.background], startPoint: .top, endPoint: .bottom)
                .frame(height: fade)
            AceTheme.Colours.background
        }
        .frame(height: fade + below)
        .offset(y: below)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
