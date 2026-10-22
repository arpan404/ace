import Foundation
import Observation
import CryptoKit

@MainActor @Observable final class ItemModel: Identifiable {
    let id: String
    var row: TranscriptRow
    init(_ row: TranscriptRow) { id = row.id; self.row = row }
}
@MainActor @Observable final class ThreadModel {
    let id: String
    var epoch = 0
    var metadata: ThreadRow?
    var items: [String: ItemModel] = [:]
    var order: [String] = []
    var interactions: [String: ApprovalRow] = [:]
    var cursor = 0
    var loaded = false
    let screen = ThreadScreenModel()
    /// What this thread last showed, kept on screen while its reopened session catches up.
    var placeholder: ThreadModel?
    /// Which folds are open; shared with the placeholder and history pages of the same thread.
    @ObservationIgnored var disclosures = Disclosures()
    @ObservationIgnored var positions: [String: Int] = [:]
    init(id: String) { self.id = id }
    var approvals: [ApprovalRow] { interactions.values.filter { $0.state == "pending" }.sorted { $0.id < $1.id } }
}

@MainActor @Observable final class ClientModel {
    private(set) var hostId: String?
    @ObservationIgnored let liveActivity: ThreadLiveActivity
    let inbox = InboxRowStore()
    var pending: [String: PendingRow] = [:]
    var connection = "connecting"
    /// Why the SDK's connection isn't ready (unreachable, revoked, pin mismatch), for a person.
    var problem: ProblemNotice?
    var error: String?
    var thread: ThreadModel?
    var inboxLoaded = false
    var inboxLayout = InboxLayout.empty
    var approvalSubmissions: [String: ApprovalSubmission] = [:]
    /// The Machines sheet's view of this runtime's computer (`bridge/machine-info.ts`).
    var machineStatus: MachineStatusInfo?
    var providers: MachineProvidersInfo?
    /// False for a view-only grant: the phone reads threads but submits no commands.
    var canOperate = true
    /// A thread a tapped notification asked to open.
    var deepLink: String?
    @ObservationIgnored var notificationSink: ((NotificationPatch) -> Void)?
    /// The open thread's Agents and Changes sheets (`bridge/sheets.ts`).
    let sheets = ThreadSheetsModel()
    /// This machine's archive while the archive sheet follows it (`bridge/archive.ts`).
    let archive = ArchiveBrowserModel()
    /// New thread and Add project on this machine; the open thread's Files sheet.
    let compose = ComposeModel()
    let files = ThreadFilesModel()
    let terminal = TerminalScreenModel()
    /// The open thread's live browser view (`Sources/Browser`, `bridge/browser-live.ts`).
    let browser = BrowserLiveModel()
    let devices = DevicesModel()
    /// The daemon reads the bridge keeps, for each screen's first frame (`ReadMirror`).
    let reads = ReadMirror()
    @ObservationIgnored private var generation = 0
    /// Confirmation fence: the newest activity generation the bridge has reported, on any
    /// connection or inbox row. Older confirmed rows read as unconfirmed until their snapshot
    /// returns, even when PatchPump delivers the connection and row frames separately.
    @ObservationIgnored private var activityGeneration = 0
    /// Threads left for a child, so going back shows them until their replacement snapshot is ready.
    @ObservationIgnored private var trail = ThreadTrail()
    @ObservationIgnored private var runtime: (any ClientSession)?
    @ObservationIgnored private let makeRuntime: ClientSessionFactory
    @ObservationIgnored private var connectionEpoch = 0
    @ObservationIgnored private var shutdown: Task<Void, Never>?
    @ObservationIgnored private var frames = BridgeFrames()
    @ObservationIgnored let admissions = CommandAdmissions()
    @ObservationIgnored let services = NativeServiceCalls()
    @ObservationIgnored var approvalRequests: [String: String] = [:]
    @ObservationIgnored let now: () -> Double
    @ObservationIgnored var metrics: SpikeMetrics?
    @ObservationIgnored var largestFrame = 0
    @ObservationIgnored var patchCount = 0
    @ObservationIgnored var streamedUpdates = 0

    init(now: @escaping () -> Double, makeRuntime: @escaping ClientSessionFactory = {
        ClientRuntime(target: $0, storageURL: $1, receive: $2, fail: $3)
    }) { self.now = now; self.makeRuntime = makeRuntime; liveActivity = ThreadLiveActivity(now: { Date(timeIntervalSince1970: now() / 1000) }) }
    func connect(target: ConnectionTarget, directory: URL, itemLimit: Int = 200) async {
        connectionEpoch += 1
        let epoch = connectionEpoch
        let closing = retireRuntime()
        hostId = target.hostId
        inbox.removeAll(); pending = [:]; thread = nil; inboxLoaded = false; sheets.reset(); archive.reset(); compose.reset(); files.reset(); reads.reset()
        inboxLayout = .empty
        machineStatus = nil; providers = nil
        connection = "connecting"; error = nil; problem = nil
        activityGeneration = 0
        frames = BridgeFrames(); generation = 0
        // The last known inbox, unconfirmed, in the first frame; the runtime replaces it in place.
        let restoring = LaunchTrace.begin("inbox.restore", target.hostId)
        let database = Self.database(hostId: target.hostId, deviceId: target.deviceId, in: directory)
        apply(InboxCheckpoint.read(database: database))
        restoring.end()
        await closing?.value
        guard connectionEpoch == epoch, !Task.isCancelled else { return }
        shutdown = nil
        // Frames are decoded off both the main thread and the script's; the main thread applies them.
        let decoder = FrameDecoder()
        let runtime = makeRuntime(target, database, { [weak self] data in
            decoder.decode(data) { patches in
                Task { @MainActor in
                    guard let self, self.connectionEpoch == epoch else { return }
                    let accepted = self.accept(patches, bytes: data.count)
                    self.runtime?.acknowledge(accepted: accepted)
                }
            }
        }, { [weak self] message in Task { @MainActor in
            guard let self, self.connectionEpoch == epoch else { return }
            self.error = message
        } })
        self.runtime = runtime
        runtime.start(itemLimit: itemLimit)
    }
    /// Outbox and cached views are bound to one host and device identity.
    nonisolated static func database(hostId: String, deviceId: String, in directory: URL) -> URL {
        let scope = SHA256.hash(data: Data("\(hostId)\u{0}\(deviceId)".utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(scope + ".sqlite")
    }
    /// Decodes and applies one frame on the main thread, as tests deliver them.
    @discardableResult func receive(_ data: Data) -> Bool {
        accept(try? frames.decode(data), bytes: data.count)
    }
    /// Applies one decoded frame; nil is a frame that could not be read.
    func accept(_ patches: [BridgePatch]?, bytes: Int) -> Bool {
        largestFrame = max(largestFrame, bytes)
        if patchCount == 0 { LaunchTrace.mark("bridge.firstFrame") }
        guard let patches else {
            error = "Could not read a client update"
            return false
        }
        HostTrace.measure("main.apply") { apply(patches) }
        return true
    }
    private func apply(_ patches: [BridgePatch]) {
        var reorder = false
        var activityChanged = false
        for patch in patches {
            patchCount += 1
            switch patch {
            case .service(let reply):
                if reply.ok, let cache = reply.cache, let value = reply.value { reads.store(key: cache.key, family: cache.family, value: value) }
                services.receive(reply)
            case .serviceCache(let cache, let value): reads.store(key: cache.key, family: cache.family, value: value)
            case .serviceGenerations(let generations): reads.update(generations: generations)
            case .terminal(let patch):
                if let offset = terminal.receive(patch) { action(["type": "terminal.credit", "id": patch.id, "offset": offset]) }
            case .fragment: break // BridgeFrames only returns complete patches.
            case .inboxReset(let ids):
                LaunchTrace.mark("inbox.reset", "\(inbox.count) rows held")
                resetInbox(keeping: ids); inboxLoaded = true; activityChanged = true
            case .inbox(let id, let row):
                if let generation = row?.generation, generation > activityGeneration {
                    activityGeneration = generation
                    normalizeGenerations()
                }
                if inbox.isEmpty, row != nil { LaunchTrace.mark("inbox.firstRow", row?.confirmed == true ? "confirmed" : "unconfirmed") }
                if let current = row {
                    // Missing generations (old payloads) never confirm.
                    inbox[id] = ThreadLiveActivity.effectiveRow(current, latestGeneration: activityGeneration)
                } else {
                    inbox[id] = nil
                }
                activityChanged = true
            case .inboxSections(let layout): if inboxLayout != layout { inboxLayout = layout }
            case .connection(let state, let generation):
                if state != connection { LaunchTrace.mark("connection", state) }
                connection = state
                if let generation, generation > activityGeneration {
                    activityGeneration = generation
                    normalizeGenerations()
                }
                // A welcome before its sidebar snapshot must not resurrect a cached done row:
                // only a fresh bridge row may confirm again, never connectivity alone.
                if state != "ready" { invalidateConfirmations() }
                activityChanged = true
            case .problem(let notice): problem = notice
            case .machineStatus(let info): machineStatus = info
            case .machineProviders(let info): providers = info
            case .pending(let id, let row): pending[id] = row
            case .error(let message): error = message
            case .notification(let patch): notificationSink?(patch)
            case .receipt(let id, let ok, let message):
                if let interactionId = approvalRequests[id], approvalSubmissions[interactionId]?.requestId == id {
                    if ok { approvalSubmissions[interactionId]?.phase = .waiting }
                    else { approvalSubmissions[interactionId] = nil; approvalRequests[id] = nil }
                }
                // A refused Stop leaves the tree working: offer Stop again.
                if !ok { error = message; thread?.screen.stopFailed(id) }
            case .admission(let id, let ok, let message):
                admissions.resolve(id, persisted: ok)
                if let interactionId = approvalRequests[id], approvalSubmissions[interactionId]?.requestId == id {
                    if ok { approvalSubmissions[interactionId]?.phase = .waiting }
                    else { approvalSubmissions[interactionId] = nil; approvalRequests[id] = nil }
                }
                if !ok { error = message }
            case .threadReset(let id, let epoch):
                guard let thread, thread.id == id, epoch == thread.epoch else { continue }
                thread.epoch = epoch
                thread.items.removeAll(keepingCapacity: true)
                thread.positions.removeAll(keepingCapacity: true)
                thread.order = []
                thread.interactions = [:]
                thread.loaded = false
                thread.screen.reset()
            case .position(let id, let epoch, let itemId, let index):
                guard let thread, thread.id == id, thread.epoch == epoch else { continue }
                thread.positions[itemId] = index
                reorder = true
            case .item(let id, let epoch, let itemId, let row):
                guard let thread, thread.id == id, thread.epoch == epoch else { continue }
                if let row {
                    if let item = thread.items[itemId] { item.row = row; streamedUpdates += 1 }
                    else { thread.items[itemId] = ItemModel(row); reorder = true }
                    if let index = row.index, thread.positions[itemId] != index { thread.positions[itemId] = index; reorder = true }
                } else { thread.items.removeValue(forKey: itemId); thread.positions.removeValue(forKey: itemId); reorder = true }
            case .metadata(let id, let epoch, let row): if thread?.id == id, thread?.epoch == epoch { thread?.metadata = row }
            case .interaction(let id, let epoch, let interactionId, let row):
                if thread?.id == id, thread?.epoch == epoch {
                    thread?.interactions[interactionId] = row
                    if row?.state != "pending", let submission = approvalSubmissions.removeValue(forKey: interactionId) { approvalRequests[submission.requestId] = nil }
                }
            case .cursor(let id, let epoch, let cursor): if thread?.id == id, thread?.epoch == epoch { thread?.cursor = cursor }
            case .ready(let id, let epoch, _): if thread?.id == id, thread?.epoch == epoch { thread?.loaded = true; thread?.placeholder = nil }
            case .block, .blockPosition, .controls, .history, .models, .queue:
                if let thread, let scope = patch.screenScope, scope.thread == thread.id, scope.epoch == thread.epoch {
                    thread.screen.apply(patch)
                }
            case .agents(let id, let epoch, let sheet): if thread?.id == id, thread?.epoch == epoch { sheets.agents = sheet }
            case .changesSummary(let id, let epoch, let summary): if thread?.id == id, thread?.epoch == epoch { sheets.changes = summary }
            case .changesFile(let id, let epoch, let path, let diff):
                if thread?.id == id, thread?.epoch == epoch { sheets.file = .init(path: path, diff: diff) }
            case .gitResult(let id, let ok, let message): sheets.outcomes[id] = GitOutcome(ok: ok, message: message)
            case .gitDraft(let draft): sheets.draft = draft
            case .archiveList(let list): archive.apply(list)
            case .compose(let patch): compose.apply(patch)
            case .files(let patch): files.apply(patch)
            case .screen(let id, let epoch, let screen):
                if let thread, thread.id == id, thread.epoch == epoch { thread.screen.apply(screen) }
            case .browser(let patch): browser.apply(patch)
            case .devices(let patch): devices.apply(patch)
            }
        }
        thread?.screen.commit()
        if activityChanged, let hostId { liveActivity.update(rows: inbox.dictionary, hostId: hostId, online: connection == "ready") }
        if reorder, let thread {
            thread.order = thread.positions.keys.filter { thread.items[$0] != nil }.sorted {
                (thread.positions[$0] ?? 0) < (thread.positions[$1] ?? 0)
            }
        }
    }
    /// A new list keeps the rows it names until each fresh copy lands, so the inbox never blanks
    /// or jumps to the top while the rest arrive; it drops every other row. A kept row is no
    /// longer confirmed: only its fresh copy may say it is current again.
    private func resetInbox(keeping ids: [String]?) {
        guard let ids else { inbox.removeAll(); return }
        let listed = Set(ids)
        for id in inbox.ids {
            if !listed.contains(id) { inbox[id] = nil }
            else if var held = inbox[id], held.confirmed != nil { held.confirmed = nil; inbox[id] = held }
        }
    }
    func open(_ id: String) {
        generation += 1
        sheets.reset()
        browser.close(streams: runtime?.browserStreams)
        let opened = ThreadModel(id: id)
        opened.epoch = generation
        opened.placeholder = trail.reopen(id, leaving: thread)
        if let placeholder = opened.placeholder { opened.disclosures = placeholder.disclosures }
        // Coming back from a child finds its subagent groups as they were left.
        opened.screen.openGroups = opened.placeholder?.screen.openGroups ?? []
        thread = opened
        action(["type": "open", "threadId": id])
    }
    func back() {
        generation += 1; action(["type": "back"]); thread = nil; trail.clear(); sheets.reset()
        browser.close(streams: runtime?.browserStreams)
    }
    /// Where this runtime's sockets deliver browser pictures (`ClientModel+Browser.swift`).
    var browserStreams: BrowserStreamHub? { runtime?.browserStreams }
    /// The runtime the live browser's acknowledgements go to, straight from its decoding queue.
    var browserSession: (any ClientSession)? { runtime }
    /// A sheet action for the open thread (`bridge/sheets.ts`).
    @discardableResult func sheet(_ value: [String: Any]) -> Bool { action(["type": "sheet", "action": value]) }
    /// Durable stop through the SDK's outbox: true once admitted on this device. `agentId` nil
    /// stops the whole tree; otherwise that agent and everything under it.
    func interrupt(agentId: String?) async -> Bool {
        guard canOperate, let thread else { return false }
        var payload: [String: Any] = ["type": "thread.interrupt", "threadId": thread.id, "cascade": true]
        if let agentId { payload["agentId"] = agentId } else { payload["beforeSeq"] = thread.cursor }
        let id = admissions.nextId()
        return await admissions.wait(id: id) { command(payload, requestId: id) }
    }
    func stopTask(_ taskId: String) async -> Bool {
        guard canOperate else { return false }
        let id = admissions.nextId()
        return await admissions.wait(id: id) { command(["type": "background_task.stop", "taskId": taskId], requestId: id) }
    }
    func network(_ online: Bool) { action(["type": "network", "online": online]) }
    func retry() { action(["type": "retry"]) }
    /// Ask the computer for its CLIs and usage; runs on the next ready connection if offline.
    func refreshMachine() { action(["type": "machine.refresh"]) }
    func send(_ text: String, delivery: String) async -> Bool {
        guard canOperate, let thread, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        let id = admissions.nextId()
        return await admissions.wait(id: id) {
            command(["type": "thread.send", "threadId": thread.id, "input": [["type": "text", "text": text]], "delivery": delivery], requestId: id)
        }
    }
    func approve(_ interaction: ApprovalRow, option: ApprovalRow.Option) {
        guard canOperate, interaction.state == "pending", approvalSubmissions[interaction.id] == nil else { return }
        let id = admissions.nextId()
        approvalSubmissions[interaction.id] = ApprovalSubmission(requestId: id, phase: .saving)
        approvalRequests[id] = interaction.id
        if !command(["type": "interaction.resolve", "interactionId": interaction.id, "resolution": ["kind": "approval", "optionId": option.id]], requestId: id) {
            approvalSubmissions[interaction.id] = nil
            approvalRequests[id] = nil
        }
    }
    /// Inbox organization (`bridge/inbox.ts`): true once the SDK durably admitted the command.
    func inboxCommand(_ value: [String: Any]) async -> Bool {
        guard canOperate else { return false }
        let id = admissions.nextId()
        return await admissions.wait(id: id) { action(["type": "inbox", "action": value, "requestId": id]) }
    }
    /// Inbox reads that admit nothing durable, such as loading older threads.
    func inboxRequest(_ value: [String: Any]) { action(["type": "inbox", "action": value, "requestId": admissions.nextId()]) }
    /// `notifications.*` bridge actions (Sources/Notifications).
    @discardableResult func notificationAction(_ value: [String: Any]) -> Bool { action(value) }
    @discardableResult func command(_ payload: [String: Any], requestId: String? = nil) -> Bool {
        let dispatched = action(["type": "command", "payload": payload, "requestId": requestId ?? admissions.nextId()])
        if !dispatched { error = "Could not submit the request. Your draft is still available." }
        return dispatched
    }
    @discardableResult func action(_ value: [String: Any]) -> Bool {
        guard let runtime else { return false }
        return Self.action(value, to: runtime)
    }
    /// A bridge action from any thread; the session's VM thread runs actions in the order sent.
    @discardableResult nonisolated static func action(_ value: [String: Any], to session: any ClientSession) -> Bool {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return false }
        session.invoke("aceAction", json: String(decoding: data, as: UTF8.self))
        return true
    }
    func disconnectAndWait() async {
        connectionEpoch += 1
        let epoch = connectionEpoch
        await retireRuntime()?.value
        if connectionEpoch == epoch { shutdown = nil }
    }
    func disconnect() { connectionEpoch += 1; _ = retireRuntime() }
    /// Drop held confirmations when leaving ready: a cached done row stays cached, but never
    /// confirmed, until its sidebar snapshot returns. Only a fresh inbox row may set it again.
    private func invalidateConfirmations() {
        for id in inbox.ids {
            guard let row = inbox[id], row.confirmed == true else { continue }
            var cleared = row
            cleared.confirmed = nil
            inbox[id] = cleared
        }
    }
    /// Drop confirmations from older generations: PatchPump may deliver a ready connection
    /// before the row frames that invalidate it, so older confirmed rows never finish.
    /// One rule lives in `ThreadLiveActivity.effectiveRow`; the authority value stays here.
    private func normalizeGenerations() {
        for id in inbox.ids {
            guard let row = inbox[id] else { continue }
            let effective = ThreadLiveActivity.effectiveRow(row, latestGeneration: activityGeneration)
            if effective.confirmed != row.confirmed { inbox[id] = effective }
        }
    }
    private func retireRuntime() -> Task<Void, Never>? {
        invalidateConfirmations()
        // The next runtime restarts the bridge fence at zero: explicit reset so counter
        // rows from a replaced runtime can never stay Syncing forever against an old max.
        activityGeneration = 0
        if let hostId { liveActivity.update(rows: inbox.dictionary, hostId: hostId, online: false) }
        services.cancel()
        admissions.cancel()
        approvalSubmissions = [:]; approvalRequests = [:]
        browser.close(streams: runtime?.browserStreams)
        guard let runtime else { return shutdown }
        self.runtime = nil
        let previous = shutdown
        let closing = Task {
            await previous?.value
            await withCheckedContinuation { continuation in runtime.stop { continuation.resume() } }
        }
        shutdown = closing
        return closing
    }
}
