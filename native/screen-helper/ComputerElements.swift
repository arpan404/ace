import AppKit
import ApplicationServices

/// AXUIElement identity for dictionaries: equal refs name the same live UI element.
struct CUElementKey: Hashable {
    let element: AXUIElement
    static func == (lhs: Self, rhs: Self) -> Bool { CFEqual(lhs.element, rhs.element) }
    func hash(into hasher: inout Hasher) { hasher.combine(CFHash(element)) }
}

/// Stable integer ids per app. An element keeps its id for as long as it exists, so the model
/// can act on ids from an earlier observation and diffs stay small.
@MainActor final class CUElementRegistry {
    private var ids: [CUElementKey: Int] = [:]
    private var elements: [Int: AXUIElement] = [:]
    private var seen: [Int: UInt64] = [:]
    private var next = 1
    private var generation: UInt64 = 0

    func beginWalk() { generation += 1 }
    func id(for element: AXUIElement) -> Int {
        let key = CUElementKey(element: element)
        if let id = ids[key] { seen[id] = generation; return id }
        let id = next
        next += 1
        ids[key] = id; elements[id] = element; seen[id] = generation
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
        }
    }
}

let cuFetchedAttributes = [
    "AXRole", "AXSubrole", "AXRoleDescription", "AXTitle", "AXDescription", "AXValue",
    "AXEnabled", "AXFocused", "AXSelected", "AXPosition", "AXSize", "AXPlaceholderValue",
    "AXHelp", "AXURL", "AXExpanded", "AXIdentifier",
]

/// One round trip for every attribute the tree needs. Missing attributes are simply absent.
func cuFetch(_ element: AXUIElement) -> [String: AnyObject] {
    var values: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(element, cuFetchedAttributes as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values) == .success,
          let array = values as? [AnyObject] else { return [:] }
    var out: [String: AnyObject] = [:]
    for (index, name) in cuFetchedAttributes.enumerated() where index < array.count {
        let value = array[index]
        if value is NSNull { continue }
        if CFGetTypeID(value) == AXValueGetTypeID(), AXValueGetType(value as! AXValue) == .axError { continue }
        out[name] = value
    }
    return out
}

func cuAttribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success, let value else { return nil }
    return value as AnyObject
}

func cuRole(_ element: AXUIElement) -> String { cuAttribute(element, "AXRole") as? String ?? "" }

func cuActionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
    return names as? [String] ?? []
}

/// Children, bounded. Huge lists fall back to their visible part.
func cuChildren(_ element: AXUIElement, limit: Int) -> (children: [AXUIElement], truncated: Bool) {
    var count: CFIndex = 0
    guard AXUIElementGetAttributeValueCount(element, "AXChildren" as CFString, &count) == .success, count > 0 else { return ([], false) }
    if count > limit {
        for visible in ["AXVisibleChildren", "AXVisibleRows"] {
            if let rows = cuAttribute(element, visible) as? [AXUIElement], !rows.isEmpty, rows.count <= limit { return (rows, true) }
        }
    }
    var values: CFArray?
    guard AXUIElementCopyAttributeValues(element, "AXChildren" as CFString, 0, min(count, limit), &values) == .success else { return ([], false) }
    return ((values as? [AXUIElement]) ?? [], count > limit)
}

func cuFrame(_ attributes: [String: AnyObject]) -> CGRect? {
    guard let position = attributes["AXPosition"], let size = attributes["AXSize"],
          CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, extent = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &extent) else { return nil }
    return CGRect(origin: point, size: extent)
}

func cuFrame(of element: AXUIElement) -> CGRect? {
    var attributes: [String: AnyObject] = [:]
    attributes["AXPosition"] = cuAttribute(element, "AXPosition")
    attributes["AXSize"] = cuAttribute(element, "AXSize")
    return cuFrame(attributes)
}

/// The window-server id of an AX window. Private but stable since macOS 10.x.
func cuWindowNumber(_ window: AXUIElement) -> CGWindowID? {
    typealias GetWindow = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow") else { return nil }
    var id: CGWindowID = 0
    return unsafeBitCast(symbol, to: GetWindow.self)(window, &id) == .success && id != 0 ? id : nil
}

/// AX lists only windows on the current Space. Windows on other Spaces (or behind a full-screen
/// app) are reachable by their remote tokens, the same element ids AX would hand out.
func cuRemoteWindows(pid: pid_t, wanted: Set<CGWindowID>) -> [AXUIElement] {
    typealias Create = @convention(c) (CFData) -> Unmanaged<AXUIElement>?
    guard !wanted.isEmpty, let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementCreateWithRemoteToken") else { return [] }
    let create = unsafeBitCast(symbol, to: Create.self)
    var found: [AXUIElement] = []
    var remaining = wanted
    let started = DispatchTime.now().uptimeNanoseconds
    for elementId in UInt64(0)..<20_000 where !remaining.isEmpty {
        if DispatchTime.now().uptimeNanoseconds - started > 400_000_000 { break }
        var token = Data(count: 20)
        token.withUnsafeMutableBytes { bytes in
            bytes.storeBytes(of: pid, toByteOffset: 0, as: Int32.self)
            bytes.storeBytes(of: Int32(0), toByteOffset: 4, as: Int32.self)
            bytes.storeBytes(of: Int32(0x636f_636f), toByteOffset: 8, as: Int32.self)
            bytes.storeBytes(of: elementId, toByteOffset: 12, as: UInt64.self)
        }
        guard let element = create(token as CFData)?.takeRetainedValue(), cuRole(element) == "AXWindow",
              let number = cuWindowNumber(element), remaining.contains(number) else { continue }
        remaining.remove(number)
        found.append(element)
    }
    return found
}

struct CUWindow {
    let element: AXUIElement
    let number: CGWindowID?
    let title: String
    let frame: CGRect
    let onScreen: Bool
    let minimized: Bool
    let main: Bool
}

/// The app's real windows, on any Space: titled document windows, dialogs and panels.
@MainActor func cuWindows(pid: pid_t) -> [CUWindow] {
    let application = AXUIElementCreateApplication(pid)
    var elements = cuAttribute(application, "AXWindows") as? [AXUIElement] ?? []
    let info = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
    var onScreen = Set<CGWindowID>()
    var serverWindows = Set<CGWindowID>()
    for row in info where (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid && (row[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 {
        guard let number = (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
              let bounds = row[kCGWindowBounds as String] as? [String: Any],
              let height = (bounds["Height"] as? NSNumber)?.doubleValue, let width = (bounds["Width"] as? NSNumber)?.doubleValue,
              height >= 60, width >= 60 else { continue }
        serverWindows.insert(number)
        if (row[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true { onScreen.insert(number) }
    }
    let known = Set(elements.compactMap(cuWindowNumber))
    let missing = serverWindows.subtracting(known)
    if !missing.isEmpty { elements += cuRemoteWindows(pid: pid, wanted: missing) }
    let main = cuAttribute(application, "AXMainWindow").map { $0 as! AXUIElement }
    return elements.compactMap { element in
        let attributes = cuFetch(element)
        guard let frame = cuFrame(attributes), frame.width >= 60, frame.height >= 40 else { return nil }
        let number = cuWindowNumber(element)
        let minimized = cuAttribute(element, "AXMinimized") as? Bool ?? false
        return CUWindow(element: element, number: number, title: attributes["AXTitle"] as? String ?? "", frame: frame,
                        onScreen: number.map { onScreen.contains($0) } ?? false, minimized: minimized,
                        main: main.map { CFEqual($0, element) } ?? false)
    }
}
