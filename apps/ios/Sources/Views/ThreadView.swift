import SwiftUI

struct ThreadView: View {
    /// Going back a page, read where it is used: the body never depends on `dismiss`.
    @State private var back = DismissBox()
    /// Closes the thread open beside the list, which has no page under it to go back to.
    @Environment(\.closeOpenThread) private var closeOpenThread
    @Environment(\.threadDrawerOpen) private var drawerOpen
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.aceReduceMotion) private var reduceMotion
    @Environment(\.threadDrafts) private var drafts
    @Environment(\.threadOrganizer) private var organizer
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
    /// The page showing on a phone (`ThreadPager`), and the one last asked for, which stays in
    /// the pill row while it shows even before the thread has something for it.
    @State private var page: ThreadPageKind = .chat
    @State private var requestedPage: ThreadPageKind?
    /// A native subagent opened from the Agents page, pushed over the thread.
    @State private var agentRoute: SubagentRoute?
    @State private var media: TranscriptRow?
    @State private var fullMessage: TranscriptRow?
    @State private var showTools = false
    @State private var showScripts = false
    @State private var showComputer = false
    @State private var devicesRoute: DevicesRoute?
    @State private var activityProblem: String?
    @State private var showWork = false
    /// The problem line's and Not sent's ways out: one at a time, with their questions.
    @State private var workRunner = WorkRunner()
    @State private var confirmingLock = false
    @State private var showLogs = false
    @State private var showSearch = false
    @State private var showQueue = false
    /// Where the iPad's side panel goes; `.none` keeps every tool over the thread, as on a phone.
    @Environment(\.panelPlace) private var panelPlace
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
    @State private var renaming = false
    @State private var transitionSheet: ThreadSheet?
    /// The fork the composer writes to, once its words are in place (`screen.fork`).
    @State private var forkKey: String?
    /// Bumped to bring the keyboard up: a fork opened, a message edited.
    @State private var composerFocus = 0
    /// Each fork the machine started: a success tap as it opens.
    @State private var forksStarted = 0
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
    /// The pages this thread offers on a phone; beside the iPad's side panel, Chat alone.
    private var pages: ThreadPages {
        guard panelPlace == .none else { return ThreadPages(ThreadPageFacts(chat: true)) }
        let row = model.inbox[thread.id] ?? metadata
        return ThreadPages(ThreadPageFacts(chat: row?.chat == true, changedFiles: row?.diff?.files ?? 0,
                                           hasBrowser: model.threadHasBrowser, agents: row?.agents ?? 1,
                                           requested: requestedPage))
    }
    private var shownPage: ThreadPageKind { pages.shown(page) }
    private var subtitle: String {
        guard let metadata else { return "" }
        let place = metadata.branch.isEmpty ? metadata.machine : metadata.branch
        return [metadata.project, place].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    var body: some View {
        GeometryReader { geometry in
            content(pageWidth: geometry.size.width)
        }
        .background { DismissCapture(box: back) }
    }

    private var feed: some View {
        ConversationFeed(model: model, thread: thread, acceptedSend: acceptedSend,
                         links: TranscriptLinks(openThread: openThread, openAgent: { lane = $0 }, steps: StepsLinks(model: model, screen: thread.screen, epoch: thread.epoch),
                                                openMedia: { media = $0 }, openChanges: { open(.changes) }, openMessage: { DisclosureTrace.shared.asked("message", key: $0.id); fullMessage = $0 },
                                                openAgents: { open(.agents) }, threadStatus: { model.inbox[$0]?.status },
                                                threadTitle: { model.inbox[$0]?.title }),
                         barHeight: barHeight, behind: $behind, jumps: jumps)
            .publishedMedia(model: model, threadId: thread.id)
            .markdownShelf(threadId: thread.id)
    }

    /// Chat alone, or the thread's pages a swipe apart with Chat first (a phone).
    @ViewBuilder private var pager: some View {
        let pages = pages
        if pages.kinds.count < 2 {
            feed
        } else {
            ThreadPager(pages: pages, shown: Binding(get: { shownPage }, set: { select($0) }), holdsSwipe: shownPage == .browser) { kind in
                if kind == .chat {
                    feed
                } else {
                    ThreadPageBody(kind: kind, model: model, thread: thread, title: metadata?.title ?? "", subtitle: subtitle,
                                   barHeight: barHeight, openThread: openThread, openAgent: { agentRoute = $0 },
                                   openChat: { select(.chat) }, mention: model.canOperate ? { mention = $0 } : nil)
                }
            }
        }
    }

    private func content(pageWidth: CGFloat) -> some View {
        pager
            .modifier(FloatingBar(height: $barHeight) { bottomBar })
            // The height under the bar, steady while the keyboard or a card changes the insets.
            .background {
                Color.clear.ignoresSafeArea()
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
            }
            .toolbar {
                ThreadToolbar(title: metadata?.title ?? "Thread", subtitle: subtitle, status: model.headerStatus(of: thread), chat: metadata?.chat == true, pageWidth: pageWidth,
                              rename: model.canOperate && !archived ? { renaming = true } : nil,
                              retitle: model.canOperate && !archived ? { Task { _ = await model.retitle(thread.id) } } : nil,
                              titleActions: titleActions,
                              menu: ThreadMenu(model: model, thread: thread, title: metadata?.title ?? "", archived: archived, hasActivity: activityRow != nil, activityRow: { activityRow },
                                               open: open, opensInPanel: panelPlace != .none, pages: panelPlace == .none ? pages : nil,
                                               problem: { activityProblem = $0 }, leave: leave),
                              openWork: { showWork = true },
                              panel: panelPlace == .none ? nil : PanelToggle(shown: model.panels.views[thread.id]?.open == true) { panel(["op": "togglePanel"]) }, coveredByDrawer: drawerOpen,
                              pageButtons: shownPage.barButtons)
            }
            .navigationTitle(metadata?.title ?? "Thread")
            .navigationBarTitleDisplayMode(.inline)
            // The thread's own keyboard commands, in the iPad menu bar and ⌘-hold overlay. Its
            // own view, so the row it reads redraws only it, never the transcript.
            .background { ThreadKeysPublisher(model: model, thread: thread, open: open, leave: leave) }
            .inboxTopBar {
                VStack(spacing: AceTheme.Spacing.none) {
                    if typeSize.isAccessibilitySize, let status = model.headerStatus(of: thread) {
                        StateLabel(status: status)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, AceDesign.Space.margin).padding(.vertical, AceDesign.Space.related)
                    }
                    let pages = pages
                    if pages.kinds.count > 1 {
                        ThreadPageBar(pages: pages, shown: shownPage) { select($0) }
                    }
                }
            }
            .threadSheets(model: model, thread: thread, work: $showWork, logs: $showLogs)
            .navigationDestination(item: $agentRoute) { route in
                SubagentView(route: route, model: model, thread: thread, push: { agentRoute = $0 },
                             openThread: { child in agentRoute = nil; openThread(child) })
            }
            .threadTransitions(model: model, thread: thread, title: metadata?.title ?? "", renaming: $renaming, sheet: $transitionSheet,
                               openThread: openThread)
            .sensoryFeedback(.success, trigger: forksStarted)
            // A new thread started from this one (a fork, a continuation): a success tap as it opens.
            .onChange(of: screen.continued) { _, opened in if opened != nil { forksStarted += 1 } }
            // A fork opened: its words go where the composer keeps them (an edited message's to
            // start with), then the composer writes to it with the keyboard up.
            .onChange(of: screen.fork?.key, initial: true) { _, key in
                guard let fork = screen.fork, let hostId = model.hostId, key != nil else {
                    forkKey = nil
                    return
                }
                let kept = ThreadDrafts.key(hostId: hostId, threadId: fork.key)
                if !fork.prefill.isEmpty, drafts?.text(for: kept).isEmpty ?? false { drafts?.save(fork.prefill, for: kept) }
                forkKey = kept
                composerFocus += 1
            }
            .workQuestions(runner: workRunner, model: model, confirmingLock: $confirmingLock)
            .environment(\.clearStaleLock, model.canOperate ? { confirmingLock = true } : nil)
            .alert("Live Activity", isPresented: Binding(get: { activityProblem != nil }, set: { if !$0 { activityProblem = nil } })) {
                Button("OK") { activityProblem = nil }
            } message: { Text(activityProblem ?? "") }
            .environment(\.openStep) { opens in
                if opens == "computer" { showComputer = true } else if opens.hasPrefix("device:") { devicesRoute = .device(String(opens.dropFirst(7))) }
            }
            .navigationDestination(item: $devicesRoute) { route in DevicesRouteView(model: model, threadId: thread.id, route: route) }
            .navigationDestination(isPresented: $showComputer) { RemoteScreenView(model: model, threadId: thread.id) }
            .sheet(isPresented: $showScripts) {
                NavigationStack {
                    ProjectScriptsView(model: model, threadId: thread.id) { url in
                        showScripts = false
                        model.browserNewTab(url)
                        open(.browser)
                    }
                }.presentationDetents([.large]).presentationDragIndicator(.visible)
            }
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
            .modifier(ThreadFileRoutes(model: model, threadId: thread.id, subtitle: subtitle, showFiles: .constant(false),
                                       mention: model.canOperate ? { mention = $0 } : nil))
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
                               canSteer: screen.controls?.delivery == "steer" || screen.controls?.alternate == "steer",
                               edit: { message, change in await model.editQueued(message, change: change) },
                               act: { await model.actOnQueue($0) }, showMore: { model.showMoreQueued() },
                               words: { await model.queuedWords($0) },
                               saveWords: { await model.editQueuedWords($0, text: $1, revision: $2) })
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
            .environment(\.openBrowser, { open(.browser) })
            .panelCommands(panelCommands)
            // A file picked in the side panel's Files goes into this composer.
            .onChange(of: model.panels.mentioned) { _, picked in
                if let picked, picked.scope == thread.id { mention = picked.mention }
            }
            .environment(\.stopBackground, model.canOperate ? { id in Task { _ = await model.stopTask(id) } } : nil)
            .environment(\.stripTasks, Set(screen.leftRunning?.taskIds ?? []))
            #if ACE_FIXTURE
            .overlay(alignment: .topLeading) {
                if SpikeConfiguration.enabled && ProcessInfo.processInfo.arguments.contains("--spike-metrics") {
                    Text(verbatim: "\(thread.items.count) items · \(model.connection)").aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                        .padding(AceDesign.Space.tight).background(.thinMaterial, in: AceShape.capsule).allowsHitTesting(false)
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
    /// Whether a strip shows above the composer, by the same order the strip's own chain reads.
    private var hasStrip: Bool {
        !thread.approvals.isEmpty
            || (screen.queue?.strip).map { HoldStripState.of(strip: $0, canOperate: model.canOperate, archived: archived).visible } == true
            || screen.queue?.notSent != nil || screen.leftRunning != nil
            || model.transfers.thread(thread.id)?.line != nil || screen.work != nil
    }

    @ViewBuilder private var bottomBar: some View {
        let request = thread.approvals.first
        VStack(spacing: AceTheme.Spacing.none) {
            // Whether a request takes the pill's place is the bridge's (`livePill`).
            // Scroll to end floats over the transcript; the live pill sits by the model, lower down.
            ComposerFloaters(pill: nil, behind: behind, open: openPill) { jumps += 1 }
                .padding(.bottom, AceDesign.Space.related)
            VStack(spacing: AceTheme.Spacing.none) {
                // Just above the strip: the model on the left, the live pill ("1m 34s · waiting on
                // 3 agents") to its right.
                ComposerPills(model: model.canOperate && !archived && screen.controls != nil ? screen : nil,
                              pill: screen.pill, open: openPill,
                              openModel: { showModels = true }, openTune: { showTune = true }, openSettings: { showSettings = true })
                // The one strip and the composer as one glass block (`GlassBlock`): the strip is
                // the block's top section, what needs the person first.
                VStack(spacing: AceTheme.Spacing.none) {
                Group {
                    if !thread.approvals.isEmpty {
                        RequestStrip(requests: thread.approvals, model: model, questionDraft: $questionDraft, openBrowser: { open(.browser) })
                    }
                    // Then what holds the queue: a usage limit, a stopped turn, a paused queue.
                    else if let hold = screen.queue?.strip,
                            HoldStripState.of(strip: hold, canOperate: model.canOperate, archived: archived).visible {
                        QueueHoldStrip(strip: hold,
                                       canAct: HoldStripState.of(strip: hold, canOperate: model.canOperate, archived: archived).actionable,
                                       act: { await model.actOnQueue($0) },
                                       chooseModel: { showModels = true }, openQueue: { showQueue = true })
                    }
                    // A message that didn't go, with Try again, Edit and Remove.
                    else if let held = screen.queue?.notSent {
                        NotSentStrip(message: held, canAct: model.canOperate && !archived, act: { await model.actOnQueue($0) },
                                     edit: { message, change in await model.editQueued(message, change: change) },
                                     words: { await model.queuedWords(held.id) },
                                     saveWords: { await model.editQueuedWords(held.id, text: $0, revision: $1) })
                    }
                    // Commands a stopped turn left running, with one Stop.
                    else if let left = screen.leftRunning {
                        LeftRunningStrip(row: left, canAct: model.canOperate && !archived) { id in _ = await model.stopTask(id) }
                    }
                    // A request needs the person first; the transfer's line waits under it.
                    else if let line = model.transfers.thread(thread.id)?.line { ThreadTransferStrip(model: model, line: line) }
                    // What stops the checkout waits under a request and a transfer.
                    else if let line = screen.work {
                        WorkProblemLine(model: model, line: line, runner: workRunner, openWork: { showWork = true }, confirmLock: { confirmingLock = true })
                    }
                }
                // A strip rises out of the composer and fades; with Reduce Motion it only fades.
                .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
                if hasStrip { BlockHairline() }
                if archived {
                    ArchivedNote(canOperate: model.canOperate) { await model.unarchive(thread.id) }
                        .modifier(ComposerFrame(padding: EdgeInsets(top: AceDesign.Space.related, leading: AceDesign.Space.margin, bottom: AceDesign.Space.related, trailing: AceDesign.Space.margin)))
                } else if model.canOperate {
                    ComposerView(controls: screen.controls, stopping: screen.stopping,
                                 placeholder: screen.fork != nil ? "Message the fork" : asking == nil ? placeholder : "Reply…",
                                 send: { text, alternate, references in
                                     let reply = asking.map { QuestionReply(interactionId: $0.id, draft: questionDraft) }
                                     let saved = await model.sendMessage(text, alternate: alternate, reply: reply, references: references)
                                     if saved { acceptedSend += 1 }
                                     return saved
                                 }, stop: { model.stopTree() },
                                 inputBegan: { model.metrics?.inputBegan() }, mention: mention,
                                 // Paste, drop and folders join the attach menu's lock: no file joins while a
                                 // new thread starts from this message (the bridge refuses one anyway).
                                 intake: screen.attachmentsLocked != nil ? nil : { providers in
                                     Task {
                                         let result = await ComposerIntake.stage(providers, into: AttachmentStaging())
                                         attachProblem = result.note
                                         for file in result.files { model.attach(file) }
                                     }
                                 },
                                 recall: { older in await model.sentText(thread.id, older: older) },
                                 files: screen.attachments.count + screen.annotations.count,
                                 draftKey: forkKey ?? model.hostId.map { ThreadDrafts.key(hostId: $0, threadId: thread.id) },
                                 suggester: suggester, suggestionHeight: max(AceDesign.Size.tap * 2, height * (request == nil ? 0.4 : 0.22)),
                                 run: runComposerAction, focusRequest: composerFocus) {
                        if let fork = screen.fork {
                            ForkStrip(fork: fork) { model.closeFork() }
                                .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .bottom)))
                        }
                        ComposerAccessories(model: model, screen: screen, problem: attachProblem)
                    } leading: { pick in
                        AttachMenu(stage: { model.attach($0) }, problem: $attachProblem, more: suggester.adding, pickMore: pick, recall: true, ask: $askAttach)
                            .foregroundStyle(AceTheme.Colours.foreground)
                            .disabled(screen.attachmentsLocked != nil)
                    } access: {
                        ThreadAccessChip(access: screen.access) { mode in Task { _ = await model.setAccess(mode) } }
                    } model: {
                        ComposerModelButton(screen: screen, open: { showModels = true }, openTune: { showTune = true })
                    } settings: {
                        Button { showSettings = true } label: {
                            Image(systemName: "slider.horizontal.3").font(.system(size: AceDesign.Size.icon))
                                .foregroundStyle(AceTheme.Colours.foreground)
                                .frame(maxWidth: .infinity, maxHeight: .infinity).contentShape(Circle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Model and access").accessibilityIdentifier("composer.settings")
                    }
                    // The model sits on top (`ThreadModelPill`); the composer keeps room to type.
                    .showsOptions(false)
                    .task(id: thread.id) {
                        suggester.attach(model)
                        suggester.scope = .thread(thread.id)
                        suggester.readAhead()
                    }
                } else {
                    ViewOnlyNote.thread
                        .modifier(ComposerFrame(padding: EdgeInsets(top: AceDesign.Space.row, leading: AceDesign.Space.margin, bottom: AceDesign.Space.row, trailing: AceDesign.Space.margin)))
                }
                }
                // Always one block, as the approved mockup: a strip, when there is one, on top.
                .modifier(GlassBlock(active: true))
            }
            .composerGlassGroup()
        }
        .animation(AceDesign.Motion.arriving(reduceMotion), value: request?.id)
        .animation(AceDesign.Motion.arriving(reduceMotion), value: screen.queue?.strip)
        // The fork strip rises out of the composer as it opens, or fades under Reduce Motion.
        .animation(AceDesign.Motion.arriving(reduceMotion), value: screen.fork?.key)
        .animation(AceDesign.Motion.arriving(reduceMotion), value: screen.work)
        .onChange(of: request?.id) { _, _ in questionDraft = QuestionDraftState() }
    }
    /// Archiving or snoozing leaves the thread: back a page, or closed when it is the open one.
    private func leave() {
        if let close = closeOpenThread, close.id == thread.id { close.close() } else { back.dismiss?() }
    }
    /// A pill part opens what it names.
    private func openPill(_ opens: String) {
        switch opens {
        case "agents": open(.agents)
        case "queue": showQueue = true
        case "goal": goalSheet = GoalPresentation(epoch: thread.epoch)
        default: break
        }
    }
    /// A builtin from the composer's `/` or + list (the bridge lists only these on a thread).
    private func runComposerAction(_ action: String) {
        switch action {
        case "attach": askAttach = true
        case "plan": Task { _ = await model.setAccess("read-only") }
        case "model": showModels = true
        case "review": open(.changes)
        case "fork": open(.forkLast)
        case "attachments": open(.attachments)
        default: break
        }
    }
    /// The composer always reads the same; how a message goes while the agent works is the send
    /// button's to say.
    private let placeholder = "Ask anything"
    private func open(_ destination: ThreadDestination) {
        // Beside the thread on iPad: the tool opens as a panel tab instead of over the thread.
        if panelPlace != .none, let tool = destination.panelTool {
            panel(["op": "open", "kind": tool.rawValue])
            return
        }
        // On a phone the thread's tools are its pages.
        if panelPlace == .none, let page = destination.page {
            select(page)
            return
        }
        switch destination {
        case .rename: renaming = true
        case .forkLast: Task { _ = await model.openFork(.latest) }
        case .merge: transitionSheet = .merge
        case .turns: transitionSheet = .turns
        case .attachments: transitionSheet = .files
        case .work: showWork = true
        case .search: showSearch = true
        case .scripts: showScripts = true
        case .devices: devicesRoute = .list
        case .computer: showComputer = true
        case .tools: showTools = true
        case .logs: showLogs = true
        // Pages: with the side panel they opened as its tabs above.
        case .changes, .files, .terminal, .browser, .agents: break
        }
    }
    /// The title menu's actions, by the shared menu rules (`threadMenu`) for this thread's row.
    private var titleActions: ThreadTitleActions {
        guard model.canOperate, !archived else { return ThreadTitleActions() }
        let menu = model.inbox[thread.id]?.menu ?? []
        let labels = model.inboxLayout.menuLabels ?? [:]
        let run = { (id: String) -> (() -> Void)? in
            guard menu.contains(id), let organizer, let hostId = model.hostId else { return nil }
            return { organizer.perform(InboxKey(machineId: hostId, id: thread.id), id) }
        }
        var actions = ThreadTitleActions()
        if screen.transitions?.lastTurn == true { actions.fork = { open(.forkLast) } }
        actions.copyLink = run("copy-link")
        if let settle = run("settle") {
            actions.settle = .init(label: labels["settle"] ?? "Settle", settled: false, run: settle)
        } else if let unsettle = run("unsettle") {
            actions.settle = .init(label: labels["unsettle"] ?? "Unsettle", settled: true, run: unsettle)
        }
        return actions
    }
    /// Shows a page; asking for one keeps its pill while it shows.
    private func select(_ next: ThreadPageKind) {
        requestedPage = next == .chat ? nil : next
        guard page != next else { return }
        withAnimation(AceDesign.Motion.arriving(reduceMotion)) { page = next }
    }
    /// The panel's keys while it has room beside this thread.
    private var panelCommands: PanelCommands? {
        guard panelPlace != .none else { return nil }
        let view = model.panels.views[thread.id]
        let shown = view?.open == true ? view?.shown : nil
        return PanelCommands(act: panel, hasTab: !(view?.tabs.isEmpty ?? true), canReopen: view?.canReopen == true,
                             closable: shown.flatMap { $0.pinned ? nil : $0.key })
    }
    private func panel(_ op: [String: Any]) {
        withAnimation(AceDesign.Motion.arriving(reduceMotion)) { model.panel(thread.id, op) }
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
    private let below = AceDesign.Size.tap * 8
    private let fade = AceDesign.Space.margin
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

/// The page's current dismiss action, kept out of the thread page's body. Read there, every new
/// `DismissAction` (the navigation container hands out another whenever it updates, which with an
/// accessibility client attached is every frame) re-evaluated the page, its feed and every row.
@MainActor final class DismissBox {
    var dismiss: DismissAction?
}

/// Reads `dismiss` into the page's box; only this empty view updates when it changes.
private struct DismissCapture: View {
    let box: DismissBox
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        let _ = box.dismiss = dismiss
        Color.clear.frame(width: 0, height: 0).accessibilityHidden(true)
    }
}
