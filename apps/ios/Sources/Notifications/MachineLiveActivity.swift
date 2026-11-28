import ActivityKit
import Foundation

/// When the app starts, updates and ends one machine's Live Activity while it runs, and what it
/// writes there (ADR 0223). Pure, so the rules are tested without ActivityKit.
///
/// The machine's daemon is the activity's source while ace is closed. While ace is open, the app
/// writes the same machine's state with rows added, never at a lower `seq` than the activity
/// shows, so a late local write can't undo a newer push. It starts one when something works,
/// waits or needs the person (iOS lets an app start one only while it is open), and ends it only
/// after the machine has been confirmed quiet for `quietGrace`. Rows the machine hasn't
/// confirmed count as busy: the activity never ends, and never says done, on a guess.
enum MachineActivityPlan {
    typealias State = MachineActivityAttributes.ContentState
    enum Step: Equatable, Sendable { case none, start, update, end }

    /// How long a machine must stay quiet before its activity goes.
    static let quietGrace: TimeInterval = 120
    /// How long a quiet last state stays on the Lock Screen after it ends.
    static let lingerAfterEnd: TimeInterval = 15 * 60
    /// How long local content counts as current; past it the activity says "as of" its time.
    /// The hub renews it every minute while ace is open.
    static let staleAfter = LockSummary.freshFor
    /// An unchanged state is re-sent this often while ace runs, so its stale date moves on.
    static let renewEvery: TimeInterval = 60

    static func step(_ summary: LockSummary, running: Bool, allowed: Bool, foreground: Bool,
                     quietSince: Date?, now: Date) -> Step {
        guard allowed else { return running ? .end : .none }
        if summary.busy { return running ? .update : foreground ? .start : .none }
        guard running else { return .none }
        if summary.current, let quietSince, now.timeIntervalSince(quietSince) >= quietGrace { return .end }
        return .update
    }
    /// When quiet began: kept while quiet, cleared by anything busy.
    static func quietSince(_ summary: LockSummary, previous: Date?, now: Date) -> Date? {
        summary.busy || !summary.current ? nil : previous ?? now
    }
    /// The machine's state as the app writes it locally, with its rows, at `seq`: the app's own
    /// count of the machine's inbox, only while the daemon doesn't drive the activity.
    static func local(_ summary: LockSummary, seq: Int, at: Date) -> State {
        State(seq: seq, at: Int(at.timeIntervalSince1970), phase: summary.busy ? "busy" : "settled",
              needsYou: summary.needsYou, working: summary.working, failed: summary.failed, waiting: summary.waiting,
              limited: summary.limited, background: summary.background, done: 0, rows: summary.rows, localCounts: true)
    }
    /// The daemon's content is showing: its counts, phase and times stand, and only it ends the
    /// activity. Nothing showing, or the app's own count, leaves the app to write its own.
    static func daemonDriven(_ shown: State?) -> Bool { shown != nil && shown?.localCounts != true }
    /// The daemon's state with the machine's rows added, once the socket confirmed the rows go
    /// with that `seq`; nil while it hasn't, so the rows of an older state never sit beside it.
    static func withRows(_ shown: State, rows: [LockRow], confirmedSeq: Int?) -> State? {
        guard confirmedSeq == shown.seq else { return nil }
        var next = shown
        next.rows = rows
        return next
    }
    /// The `seq` a local write uses: never below what the activity shows or the app last wrote.
    static func localSeq(shown: State?, written: Int?) -> Int { max(shown?.seq ?? 0, written ?? 0) }
    /// A local write may replace what shows only at the same `seq` or later.
    static func accepts(_ next: State, over shown: State?) -> Bool { next.seq >= shown?.seq ?? Int.min }
    /// Whether to send `next` now: changed content goes at once; the same content only once
    /// `renewEvery` has passed since it was last sent.
    static func shouldSend(_ next: State, last: State?, sentAt: Date?, now: Date) -> Bool {
        guard var last, let sentAt else { return true }
        last.at = next.at
        guard last == next else { return true }
        return now.timeIntervalSince(sentAt) >= renewEvery
    }
}

/// Each paired machine's slot (0...15), the only thing its activity's attributes carry. Kept
/// across launches so a machine's activity and snapshot entry keep meaning the same machine.
/// A slot is reserved for as long as its machine is paired, attached or not; one goes to another
/// machine only once its own is gone from the directory, and its activity and token go first.
enum MachineSlots {
    static let count = 16

    /// `kept` with `host` given a slot: its own if it has one, else the lowest free one, else
    /// one whose machine is neither attached nor in `paired` (`retired`, for its activity and
    /// token to go). An unknown directory (nil) reserves every slot.
    static func assign(_ host: String, kept: [String: Int], attached: Set<String>,
                       paired: Set<String>?) -> (slots: [String: Int], retired: Int?) {
        guard kept[host] == nil else { return (kept, nil) }
        var next = kept
        let used = Set(kept.values)
        if let free = (0..<count).first(where: { !used.contains($0) }) {
            next[host] = free
            return (next, nil)
        }
        guard let paired,
              let gone = kept.filter({ !attached.contains($0.key) && !paired.contains($0.key) }).min(by: { $0.value < $1.value })
        else { return (kept, nil) }
        next.removeValue(forKey: gone.key)
        next[host] = gone.value
        return (next, gone.value)
    }
}

/// The phone's Live Activity tokens: the app's push-to-start token, and the update token of
/// each slot's one activity. Tokens belong to an activity, never to a slot: a second activity in a
/// slot (a push-to-start racing the app's own start) is refused, and an activity once retired
/// (ended, dismissed, refused, or its slot given to another machine) can't send one again.
struct LiveActivityTokens: Equatable, Sendable {
    var start: String?
    /// Each slot's one activity, by id.
    private(set) var owner: [Int: String] = [:]
    private var tokens: [String: String] = [:]
    private var retired: Set<String> = []

    /// `activity` holds `slot` unless another one already does; false: it is a duplicate to end.
    mutating func adopt(_ activity: String, slot: Int) -> Bool {
        guard !retired.contains(activity) else { return false }
        if let held = owner[slot], held != activity { return false }
        owner[slot] = activity
        return true
    }
    /// A token from an activity that holds a slot; anything else's is dropped.
    mutating func received(_ token: String, activity: String) {
        guard !retired.contains(activity), owner.values.contains(activity) else { return }
        tokens[activity] = token
    }
    /// The activity ended, was dismissed or refused: its token goes on the next sync, for good.
    mutating func retire(activity: String) {
        retired.insert(activity)
        tokens.removeValue(forKey: activity)
        owner = owner.filter { $0.value != activity }
    }
    mutating func retire(slot: Int) {
        if let activity = owner[slot] { retire(activity: activity) }
    }
    func activityToken(slot: Int) -> String? { owner[slot].flatMap { tokens[$0] } }

    /// `liveActivity` for one machine's `notifications.sync`; nil while Live Activities are off in
    /// ace or in iOS Settings, or the machine has no slot, so the machine drops both tokens.
    func sync(on: Bool, slot: Int?, environment: PushRegistration.Environment, frequentUpdates: Bool) -> [String: Any]? {
        guard on, let slot else { return nil }
        var json: [String: Any] = ["environment": environment.rawValue, "frequentUpdates": frequentUpdates, "slot": slot]
        if let start { json["startToken"] = start }
        if let token = activityToken(slot: slot) { json["activityToken"] = token }
        return json
    }
}

/// One activity on the Lock Screen and what it shows. Writes name the activity, never just its
/// slot, so a queued write can't land on a replacement started in the same slot.
struct ShownActivity: Equatable, Sendable {
    let id: String
    let state: MachineActivityAttributes.ContentState
}

/// The ActivityKit edge, substituted in tests.
@MainActor protocol MachineActivityPort: AnyObject {
    /// Live Activities are allowed in iOS Settings.
    var systemAllowed: Bool { get }
    /// iOS allows frequent pushed updates (`frequentPushesEnabled`).
    var frequentUpdates: Bool { get }
    var tokens: LiveActivityTokens { get }
    /// Tokens, or whether activities are allowed, changed: every machine's sync goes again.
    var onChange: (@MainActor () -> Void)? { get set }
    /// The slot's activity and what it shows now (pushed or written here); nil when none is up.
    func shown(_ slot: Int) -> ShownActivity?
    /// Slots whose activity is on the Lock Screen.
    var running: Set<Int> { get }
    func start(_ slot: Int, _ state: MachineActivityAttributes.ContentState, staleDate: Date) throws
    /// Writes `state` to that one activity, unless it now shows a later `seq`.
    func update(_ id: String, _ state: MachineActivityAttributes.ContentState, staleDate: Date) async
    /// Ends that one activity: with `state` as its last word, unless it now shows a later `seq`
    /// (then it stays up); with none, at once.
    func end(_ id: String, _ state: MachineActivityAttributes.ContentState?, dismissAt: Date) async
    /// The slot's machine is turned off, unpaired or its slot given away: its token goes now, so
    /// no sync after this carries it, and every activity in the slot ends at once.
    func retire(_ slot: Int)
}

/// The real ActivityKit activities, requested with push tokens so each machine's daemon can
/// update them, and observed for their tokens and their end.
@MainActor final class SystemMachineActivity: MachineActivityPort {
    typealias State = MachineActivityAttributes.ContentState
    private let authorization = ActivityAuthorizationInfo()
    var systemAllowed: Bool { authorization.areActivitiesEnabled }
    var frequentUpdates: Bool { authorization.frequentPushesEnabled }
    private(set) var tokens = LiveActivityTokens() { didSet { if tokens != oldValue { onChange?() } } }
    var onChange: (@MainActor () -> Void)?
    /// Each held activity's token and state tasks, cancelled once it is retired.
    private var watching: [String: [Task<Void, Never>]] = [:]

    init() {
        Self.endEarlierActivities()
        for activity in Activity<MachineActivityAttributes>.activities { watch(activity) }
        Task { [weak self] in
            for await data in Activity<MachineActivityAttributes>.pushToStartTokenUpdates { self?.tokens.start = Self.hex(data) }
        }
        // Push-to-start activities appear here too, so their update tokens reach the machine.
        Task { [weak self] in
            for await activity in Activity<MachineActivityAttributes>.activityUpdates {
                nonisolated(unsafe) let target = activity
                self?.watch(target)
            }
        }
        nonisolated(unsafe) let info = authorization
        Task { [weak self] in
            for await _ in info.activityEnablementUpdates { self?.onChange?() }
        }
        Task { [weak self] in
            for await _ in info.frequentPushEnablementUpdates { self?.onChange?() }
        }
    }

    private func live(_ slot: Int) -> [Activity<MachineActivityAttributes>] {
        Activity<MachineActivityAttributes>.activities.filter {
            $0.attributes.slot == slot && ($0.activityState == .active || $0.activityState == .stale)
        }
    }
    var running: Set<Int> {
        Set(Activity<MachineActivityAttributes>.activities.filter { $0.activityState == .active || $0.activityState == .stale }.map(\.attributes.slot))
    }
    /// The slot's own activity (the one holding it), never a duplicate on its way out.
    func shown(_ slot: Int) -> ShownActivity? {
        let all = live(slot)
        let held = all.first { $0.id == tokens.owner[slot] } ?? all.first
        return held.map { ShownActivity(id: $0.id, state: $0.content.state) }
    }
    private func activity(_ id: String) -> Activity<MachineActivityAttributes>? {
        Activity<MachineActivityAttributes>.activities.first { $0.id == id && ($0.activityState == .active || $0.activityState == .stale) }
    }

    /// Asks for a push token first. A build signed without `aps-environment` (Debug, CI, a free
    /// team: `ACE_PUSH: NO`) can't have one and ActivityKit refuses the request, so the activity
    /// starts local-only, as before push, and simply never reports a token.
    func start(_ slot: Int, _ state: State, staleDate: Date) throws {
        let attributes = MachineActivityAttributes(slot: slot)
        let content = ActivityContent(state: state, staleDate: staleDate)
        let activity: Activity<MachineActivityAttributes>
        do {
            activity = try Activity.request(attributes: attributes, content: content, pushType: .token)
        } catch {
            activity = try Activity.request(attributes: attributes, content: content, pushType: nil)
        }
        watch(activity)
    }
    func update(_ id: String, _ state: State, staleDate: Date) async {
        guard let found = activity(id) else { return }
        nonisolated(unsafe) let target = found
        // Checked again at the edge: a push may have landed since the hub read it.
        guard MachineActivityPlan.accepts(state, over: target.content.state) else { return }
        await target.update(ActivityContent(state: state, staleDate: staleDate))
    }
    func end(_ id: String, _ state: State?, dismissAt: Date) async {
        guard let found = activity(id) else { return }
        nonisolated(unsafe) let target = found
        guard let state else { return await target.end(nil, dismissalPolicy: .immediate) }
        // Newer work was pushed since the end was decided: the activity stays.
        guard MachineActivityPlan.accepts(state, over: target.content.state) else { return }
        await target.end(ActivityContent(state: state, staleDate: nil), dismissalPolicy: .after(dismissAt))
    }

    /// Takes an activity into its slot and follows its update token until it ends or is
    /// dismissed. A second one in a slot that is still held ends at once, its token unused.
    private func watch(_ activity: Activity<MachineActivityAttributes>) {
        let slot = activity.attributes.slot, id = activity.id
        guard watching[id] == nil else { return }
        nonisolated(unsafe) let target = activity
        // A holder that ended unseen (between launches) gives way.
        if let held = tokens.owner[slot], held != id, self.activity(held) == nil { retire(held) }
        guard tokens.adopt(id, slot: slot) else {
            tokens.retire(activity: id)
            Task { await target.end(nil, dismissalPolicy: .immediate) }
            return
        }
        let token = Task { [weak self] in
            for await data in target.pushTokenUpdates {
                guard !Task.isCancelled else { return }
                self?.tokens.received(Self.hex(data), activity: id)
            }
        }
        let state = Task { [weak self] in
            for await state in target.activityStateUpdates where state == .ended || state == .dismissed {
                self?.retire(id)
                return
            }
        }
        watching[id] = [token, state]
    }
    func retire(_ slot: Int) {
        if let held = tokens.owner[slot] { retire(held) }
        for activity in live(slot) {
            retire(activity.id)
            nonisolated(unsafe) let target = activity
            Task { await target.end(nil, dismissalPolicy: .immediate) }
        }
    }
    private func retire(_ id: String) {
        tokens.retire(activity: id)
        watching.removeValue(forKey: id)?.forEach { $0.cancel() }
    }
    private nonisolated static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

    /// Earlier builds started one activity for all agents, and before that one per thread; one
    /// per machine replaces both.
    static func endEarlierActivities() {
        for activity in Activity<AgentsActivityAttributes>.activities {
            nonisolated(unsafe) let target = activity
            Task { await target.end(nil, dismissalPolicy: .immediate) }
        }
        for activity in Activity<ThreadActivityAttributes>.activities {
            nonisolated(unsafe) let target = activity
            Task { await target.end(nil, dismissalPolicy: .immediate) }
        }
    }
}
