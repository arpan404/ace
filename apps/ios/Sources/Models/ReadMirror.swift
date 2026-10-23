import Foundation
import Observation

/// Swift's copy of the daemon reads the bridge keeps (`bridge/native-reads.ts`), so a screen
/// draws its last answer in its first frame while the bridge asks the daemon again. Each
/// family's generation moves when its answers go out of date (a daemon change, a write, a
/// reconnect); a screen showing one reads it again. The bridge decides what is kept and when it
/// is out of date; this only holds what it sent.
@MainActor @Observable final class ReadMirror {
    struct Kept { let family: String; let value: ServiceValue; let revision: Int; let bytes: Int }
    private(set) var values: [String: Kept] = [:]
    private(set) var generations: [String: Int] = [:]
    @ObservationIgnored private var decoded: [String: (revision: Int, value: Any)] = [:]
    @ObservationIgnored private var revision = 0
    @ObservationIgnored private var bytes = 0
    /// Roughly how many bytes of answers are held; past it the oldest go first.
    @ObservationIgnored let budget: Int

    init(budget: Int = 8 << 20) { self.budget = budget }

    func store(key: String, family: String, value: ServiceValue) {
        revision += 1
        let size = value.approximateBytes + key.utf8.count
        if let old = values[key] { bytes -= old.bytes }
        values[key] = Kept(family: family, value: value, revision: revision, bytes: size)
        decoded[key] = nil
        bytes += size
        trim(keeping: key)
    }
    /// The bridge stopped keeping `key`: both its answer and its decoded form go.
    func remove(_ key: String) {
        if let old = values.removeValue(forKey: key) { bytes -= old.bytes }
        decoded[key] = nil
    }
    func update(generations: [String: Int]) { if self.generations != generations { self.generations = generations } }
    func reset() { values = [:]; generations = [:]; decoded = [:]; bytes = 0 }

    /// Oldest answers go until the rest fit; the one just stored stays, however large.
    private func trim(keeping newest: String) {
        guard bytes > budget else { return }
        for (key, _) in values.sorted(by: { $0.value.revision < $1.value.revision }) where key != newest {
            remove(key)
            if bytes <= budget { return }
        }
    }

    /// The kept answer as a screen reads it; decoded once per answer.
    func value<T: Decodable>(_ key: String, as type: T.Type) -> T? {
        guard let kept = values[key] else { return nil }
        if let memo = decoded[key], memo.revision == kept.revision, let value = memo.value as? T { return value }
        let value: T
        do { value = try kept.value.decode(type) } catch {
            serviceLog.error("kept read didn't decode as \(String(describing: type), privacy: .public): \(String(describing: error), privacy: .public)")
            return nil
        }
        decoded[key] = (kept.revision, value)
        return value
    }
    /// How many times the machine came back (`reconnectsKey` in `bridge/native-reads.ts`): the
    /// one signal screens whose reads aren't kept read again on.
    var reconnects: Int { generations["reconnects"] ?? 0 }
    /// Moves when the kept answer for `key` goes out of date. With nothing kept yet (a first read
    /// that failed while the machine was away) it moves when the machine comes back, so that
    /// screen reads again too.
    func generation(_ key: String) -> Int { values[key].map { generations[$0.family] ?? 0 } ?? reconnects }

    /// A request's name in the bridge's cache: its JSON with sorted keys. Pull to refresh
    /// (`fresh`) asks for the same answer, so it names the same read.
    static func key(_ payload: [String: Any]) -> String? {
        var named = payload
        named["fresh"] = nil
        guard JSONSerialization.isValidJSONObject(named),
              let data = try? JSONSerialization.data(withJSONObject: named, options: [.sortedKeys, .withoutEscapingSlashes]) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }
}

extension ServiceValue {
    /// About how many bytes this answer takes as JSON, for the mirror's budget.
    var approximateBytes: Int {
        switch self {
        case .object(let fields): fields.reduce(2) { $0 + $1.key.utf8.count + 4 + $1.value.approximateBytes }
        case .array(let items): items.reduce(2) { $0 + $1.approximateBytes + 1 }
        case .string(let text): text.utf8.count + 2
        case .number: 8
        case .bool, .null: 4
        }
    }
}
