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
    @ObservationIgnored var positions: [String: Int] = [:]
    init(id: String) { self.id = id }
    var approvals: [ApprovalRow] { interactions.values.filter { $0.state == "pending" }.sorted { $0.id < $1.id } }
}

@MainActor @Observable final class ClientModel {
    var inbox: [String: ThreadRow] = [:]
    var pending: [String: PendingRow] = [:]
    var connection = "connecting"
    /// Why the SDK's connection isn't ready (unreachable, revoked, pin mismatch), for a person.
    var problem: ProblemNotice?
    var error: String?
    var thread: ThreadModel?
    var inboxLoaded = false
    var inboxLayout = InboxLayout.empty
    var approvalSubmissions: [String: ApprovalSubmission] = [:]
    /// False for a view-only grant: the phone reads threads but submits no commands.
    var canOperate = true
    /// A thread a tapped notification asked to open.
    var deepLink: String?
    @ObservationIgnored var notificationSink: ((NotificationPatch) -> Void)?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var runtime: (any ClientSession)?
    @ObservationIgnored private let makeRuntime: ClientSessionFactory
    @ObservationIgnored private var connectionEpoch = 0
    @ObservationIgnored private var shutdown: Task<Void, Never>?
    @ObservationIgnored private var frames = BridgeFrames()
    @ObservationIgnored private let admissions = CommandAdmissions()
    @ObservationIgnored private var approvalRequests: [String: String] = [:]
    @ObservationIgnored let now: () -> Double
    @ObservationIgnored var metrics: SpikeMetrics?
    @ObservationIgnored var largestFrame = 0
    @ObservationIgnored var patchCount = 0
    @ObservationIgnored var streamedUpdates = 0

    init(now: @escaping () -> Double, makeRuntime: @escaping ClientSessionFactory = {
        ClientRuntime(target: $0, storageURL: $1, receive: $2, fail: $3)
    }) { self.now = now; self.makeRuntime = makeRuntime }
    func connect(target: ConnectionTarget, directory: URL, itemLimit: Int = 200) async {
        connectionEpoch += 1
        let epoch = connectionEpoch
        let closing = retireRuntime()
        inbox = [:]; pending = [:]; thread = nil; inboxLoaded = false
        inboxLayout = .empty
        connection = "connecting"; error = nil; problem = nil
        frames = BridgeFrames(); generation = 0
        await closing?.value
        guard connectionEpoch == epoch, !Task.isCancelled else { return }
        shutdown = nil
        let runtime = makeRuntime(target, Self.database(hostId: target.hostId, deviceId: target.deviceId, in: directory), { [weak self] data in
            Task { @MainActor in
                guard let self, self.connectionEpoch == epoch else { return }
                let accepted = self.receive(data)
                self.runtime?.acknowledge(accepted: accepted)
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
    @discardableResult func receive(_ data: Data) -> Bool {
        largestFrame = max(largestFrame, data.count)
        guard let patches = try? frames.decode(data) else {
            error = "Could not read a client update"
            return false
        }
        var reorder = false
        for patch in patches {
            patchCount += 1
            switch patch {
            case .fragment: break // BridgeFrames only returns complete patches.
            case .inboxReset: inbox.removeAll(keepingCapacity: true); inboxLoaded = true
            case .inbox(let id, let row): inbox[id] = row
            case .inboxSections(let layout): if inboxLayout != layout { inboxLayout = layout }
            case .connection(let state): connection = state
            case .problem(let notice): problem = notice
            case .pending(let id, let row): pending[id] = row
            case .error(let message): error = message
            case .notification(let patch): notificationSink?(patch)
            case .receipt(let id, let ok, let message):
                if let interactionId = approvalRequests[id], approvalSubmissions[interactionId]?.requestId == id {
                    if ok { approvalSubmissions[interactionId]?.phase = .waiting }
                    else { approvalSubmissions[interactionId] = nil; approvalRequests[id] = nil }
                }
                if !ok { error = message }
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
            case .ready(let id, let epoch, _): if thread?.id == id, thread?.epoch == epoch { thread?.loaded = true }
            }
        }
        if reorder, let thread {
            thread.order = thread.positions.keys.filter { thread.items[$0] != nil }.sorted {
                (thread.positions[$0] ?? 0) < (thread.positions[$1] ?? 0)
            }
        }
        return true
    }
    func open(_ id: String) {
        generation += 1
        thread = ThreadModel(id: id)
        thread?.epoch = generation
        action(["type": "open", "threadId": id])
    }
    func back() { generation += 1; action(["type": "back"]); thread = nil }
    func network(_ online: Bool) { action(["type": "network", "online": online]) }
    func retry() { action(["type": "retry"]) }
    func send(_ text: String, delivery: String) async -> Bool {
        guard canOperate, let thread, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        let id = admissions.nextId()
        return await admissions.wait(id: id) {
            command(["type": "thread.send", "threadId": thread.id, "input": [["type": "text", "text": text]], "delivery": delivery], requestId: id)
        }
    }
    func stopTree() {
        guard canOperate, let thread else { return }
        command(["type": "thread.interrupt", "threadId": thread.id, "cascade": true, "beforeSeq": thread.cursor])
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
    @discardableResult private func command(_ payload: [String: Any], requestId: String? = nil) -> Bool {
        let dispatched = action(["type": "command", "payload": payload, "requestId": requestId ?? admissions.nextId()])
        if !dispatched { error = "Could not submit the request. Your draft is still available." }
        return dispatched
    }
    @discardableResult private func action(_ value: [String: Any]) -> Bool {
        guard let runtime, let data = try? JSONSerialization.data(withJSONObject: value) else { return false }
        runtime.invoke("aceAction", json: String(decoding: data, as: UTF8.self))
        return true
    }
    func disconnectAndWait() async {
        connectionEpoch += 1
        let epoch = connectionEpoch
        await retireRuntime()?.value
        if connectionEpoch == epoch { shutdown = nil }
    }
    func disconnect() { connectionEpoch += 1; _ = retireRuntime() }
    private func retireRuntime() -> Task<Void, Never>? {
        admissions.cancel()
        approvalSubmissions = [:]; approvalRequests = [:]
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
