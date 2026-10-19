import Foundation

/// A `when` guard or `wait_for` target: an element containing some text, or an element id,
/// present (or gone).
struct CUCondition: Equatable {
    let text: String?
    let id: Int?
    let gone: Bool
}

/// Reads a condition object; nil when there is none.
func cuCondition(_ value: Any?) throws -> CUCondition? {
    guard let object = value as? CUObject else {
        if value == nil || value is NSNull { return nil }
        throw CUError("bad_action", "when must be an object such as {\"text\": \"Saved\"} or {\"id\": 12, \"gone\": true}.")
    }
    let text = object.string("text").flatMap { $0.isEmpty ? nil : $0 }
    let id = object.int("id")
    guard text != nil || id != nil else { throw CUError("bad_action", "A condition needs text or id.") }
    return CUCondition(text: text, id: id, gone: object.bool("gone") ?? false)
}

/// The words of a node's outline line that text conditions search: role, name, value,
/// description and placeholder, lowercased.
func cuNodeLine(_ node: CUNode) -> String {
    [node.role, node.name, node.value, node.detail, node.placeholder].compactMap { $0 }.joined(separator: " ").lowercased()
}

/// Whether the condition holds over a fresh walk. With both id and text, that element must
/// contain the text.
func cuConditionHolds(_ condition: CUCondition, nodes: [CUNode]) -> Bool {
    let needle = condition.text?.lowercased()
    let present = nodes.contains { node in
        if let id = condition.id, node.id != id { return false }
        if let needle, !cuNodeLine(node).contains(needle) { return false }
        return true
    }
    return condition.gone ? !present : present
}

func cuConditionPhrase(_ condition: CUCondition) -> String {
    var subject = condition.id.map { "element \($0)" } ?? "an element"
    if let text = condition.text { subject += " containing \"\(cuClip(text, 60) ?? text)\"" }
    return condition.gone ? "\(subject) to go away" : subject
}

extension CUActor {
    /// Re-walks the window as the UI settles until the condition holds or time runs out.
    func waitFor(_ action: CUObject) async throws -> String {
        guard let condition = try cuCondition(action) else { throw CUError("bad_action", "wait_for needs text or id.") }
        let timeout = min(max(action.int("timeout_ms") ?? 5_000, 100), 15_000)
        let started = DispatchTime.now().uptimeNanoseconds
        func elapsed() -> Int { Int((DispatchTime.now().uptimeNanoseconds - started) / 1_000_000) }
        var lastWalk = -1_000
        while true {
            try checkpoint()
            // Walks cost the app work; look at most every 150 ms, check for a stop every 50.
            if elapsed() - lastWalk >= 150 {
                lastWalk = elapsed()
                if cuConditionHolds(condition, nodes: session.refreshNodes()) {
                    return "waited \(elapsed()) ms for \(cuConditionPhrase(condition))"
                }
            }
            guard elapsed() < timeout else { break }
            await session.settler.settle(minimumMs: 30, quietMs: 30, maximumMs: 50)
        }
        throw CUError("wait_timeout", "Waited \(timeout) ms for \(cuConditionPhrase(condition)), but it did not happen. Observe to see the current state, or wait longer.")
    }
}
