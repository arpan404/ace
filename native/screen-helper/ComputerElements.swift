import AppKit
import ApplicationServices

/// AXUIElement identity for dictionaries: equal refs name the same live UI element.
struct CUElementKey: Hashable {
    let element: AXUIElement
    static func == (lhs: Self, rhs: Self) -> Bool { CFEqual(lhs.element, rhs.element) }
    func hash(into hasher: inout Hasher) { hasher.combine(CFHash(element)) }
}

/// Every engine AX call gives up after this many seconds, so a hung app costs a bounded wait.
let cuAXTimeout: Float = 1.0

/// Stable integer ids per app. An element keeps its id for as long as it exists and shows the
/// same thing, so the model can act on ids from an earlier observation and diffs stay small.
/// Tables and lists recycle their row views: when a known element comes back showing other
/// content (its fingerprint changed) it gets a new id, and the old id stops resolving, so a
/// stale `click id` fails instead of pressing whatever row the view now shows.
@MainActor final class CUElementRegistry {
    private var ids: [CUElementKey: Int] = [:]
    private var fingerprints: [Int: String] = [:]
    private var elements: [Int: AXUIElement] = [:]
    private var seen: [Int: UInt64] = [:]
    private var next = 1
    private var generation: UInt64 = 0
    /// Role descriptions by role and subrole; they don't vary per element, so each is read once.
    var roleDescriptions: [String: String] = [:]

    func beginWalk() { generation += 1 }

    func id(for element: AXUIElement, fingerprint: String? = nil) -> Int {
        let key = CUElementKey(element: element)
        if let id = ids[key] {
            if let fingerprint, let previous = fingerprints[id], previous != fingerprint {
                elements.removeValue(forKey: id)
                fingerprints.removeValue(forKey: id)
                seen.removeValue(forKey: id)
            } else {
                if let fingerprint { fingerprints[id] = fingerprint }
                seen[id] = generation
                return id
            }
        }
        let id = next
        next += 1
        ids[key] = id; elements[id] = element; seen[id] = generation
        if let fingerprint { fingerprints[id] = fingerprint }
        return id
    }

    func existingId(for element: AXUIElement) -> Int? { ids[CUElementKey(element: element)] }
    func element(_ id: Int) -> AXUIElement? { elements[id] }

    /// Forget elements not seen in the last few walks; their ids are never reused.
    func prune() {
        guard generation > 8 else { return }
        let cutoff = generation - 8
        for (id, last) in seen where last < cutoff {
            if let element = elements.removeValue(forKey: id) { ids.removeValue(forKey: CUElementKey(element: element)) }
            seen.removeValue(forKey: id)
            fingerprints.removeValue(forKey: id)
        }
    }
}

/// One round trip for many attributes. Missing attributes are absent; the status says
/// whether the app answered at all (`.cannotComplete` means it is not responding).
func cuFetchStatus(_ element: AXUIElement, _ names: [String]) -> ([String: AnyObject], AXError) {
    var values: CFArray?
    let status = AXUIElementCopyMultipleAttributeValues(element, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
    guard status == .success, let array = values as? [AnyObject] else { return ([:], status) }
    var out: [String: AnyObject] = [:]
    for (index, name) in names.enumerated() where index < array.count {
        let value = array[index]
        if value is NSNull { continue }
        if CFGetTypeID(value) == AXValueGetTypeID(), AXValueGetType(value as! AXValue) == .axError { continue }
        out[name] = value
    }
    return (out, .success)
}

func cuAttribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success, let value else { return nil }
    return value as AnyObject
}

/// An attribute that holds an element, checked rather than force-cast.
func cuElementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
    guard let value = cuAttribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

func cuRole(_ element: AXUIElement) -> String { cuAttribute(element, "AXRole") as? String ?? "" }

func cuActionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
    return names as? [String] ?? []
}

func cuFrame(_ attributes: [String: AnyObject]) -> CGRect? {
    guard let position = attributes["AXPosition"], let size = attributes["AXSize"],
          CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, extent = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &extent) else { return nil }
    return CGRect(origin: point, size: extent)
}

func cuFrame(of element: AXUIElement) -> CGRect? {
    cuFrame(cuFetchStatus(element, ["AXPosition", "AXSize"]).0)
}
