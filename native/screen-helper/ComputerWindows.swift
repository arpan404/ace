import AppKit
import ApplicationServices

struct CUWindow {
    let element: AXUIElement
    let number: CGWindowID?
    let title: String
    let frame: CGRect
    let onScreen: Bool
    let minimized: Bool
    let main: Bool
    /// The window's stable number for this session (see `CUWindowNumbering`).
    var index: Int = 0
    var subrole: String?
    /// On another Space or behind a full-screen app: reachable through accessibility only.
    var otherSpace = false
}

private let cuWindowAttributes = ["AXRole", "AXSubrole", "AXTitle", "AXPosition", "AXSize", "AXMinimized", "AXMain"]

/// Lists one app's windows and remembers what is expensive to find again: window-server ids
/// of AX windows, windows on other Spaces reached by remote token, and stable numbers.
@MainActor final class CUWindowLister {
    let pid: pid_t
    let application: AXUIElement
    private var numberCache: [CUElementKey: CGWindowID] = [:]
    private var remote: [CGWindowID: AXUIElement] = [:]
    private var unreachable = Set<CGWindowID>()
    private var scanCursor: UInt64 = 0
    private var numbering = CUWindowNumbering<CUElementKey>()
    private(set) var last: [CUWindow] = []

    init(pid: pid_t, application: AXUIElement) {
        self.pid = pid
        self.application = application
    }

    /// `remote` searches other Spaces for windows AX does not list; callers ask for it only
    /// when the app shows no window here (`.automatic`) or a requested window is missing.
    func list(remote search: CURemoteSearch, deadline: UInt64) -> (windows: [CUWindow], notResponding: Bool) {
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(application, "AXWindows" as CFString, &value)
        if status == .cannotComplete { return (last, true) }
        var elements = (value as? [AXUIElement]) ?? []
        var numbers = elements.map(number(of:))
        if search != .none { searchOtherSpaces(known: Set(numbers.compactMap { $0 }), deadline: deadline, requested: search == .requested) }
        for (number, element) in remote where !numbers.contains(number) {
            elements.append(element)
            numbers.append(number)
        }
        let server = cuServerWindowInfo(numbers.compactMap { $0 })
        var hung = false
        var found: [CUWindow] = []
        for (element, number) in zip(elements, numbers) {
            let (attributes, status) = cuFetchStatus(element, cuWindowAttributes)
            if status == .cannotComplete { hung = true; break }
            if status == .invalidUIElement, let number { remote.removeValue(forKey: number) }
            guard let frame = cuFrame(attributes), frame.width >= 60, frame.height >= 40 else { continue }
            let minimized = attributes["AXMinimized"] as? Bool ?? false
            let row = number.flatMap { server[$0] }
            // Gone from the window server: closed, or a remote token for a window that ended.
            if let number, row == nil, remote[number] != nil { remote.removeValue(forKey: number); continue }
            let onScreen = row?.onScreen ?? false
            let otherSpace = !onScreen && !minimized && number.map { remote[$0] != nil } ?? false
            var window = CUWindow(element: element, number: number, title: attributes["AXTitle"] as? String ?? "", frame: frame,
                                  onScreen: onScreen, minimized: minimized, main: attributes["AXMain"] as? Bool ?? false)
            window.subrole = attributes["AXSubrole"] as? String
            window.otherSpace = otherSpace
            found.append(window)
        }
        if hung { return (last.isEmpty ? found : last, true) }
        let assigned = numbering.assign(found.map { CUElementKey(element: $0.element) })
        for index in found.indices { found[index].index = assigned[index] }
        found.sort { $0.index < $1.index }
        last = found
        return (found, false)
    }

    private func number(of element: AXUIElement) -> CGWindowID? {
        let key = CUElementKey(element: element)
        if let known = numberCache[key] { return known }
        guard let number = cuWindowNumber(element) else { return nil }
        if numberCache.count > 256 { numberCache.removeAll() }
        numberCache[key] = number
        return number
    }

    /// AX lists only windows on the current Space. Windows of this app on other Spaces are
    /// found among its window-server windows and reached by remote token. Ordered-out
    /// (hidden) windows belong to no Space and are never considered.
    /// Automatic searches give up on windows a pass up to a lower ceiling missed; a request
    /// for a specific missing window searches further.
    private func searchOtherSpaces(known: Set<CGWindowID>, deadline: UInt64, requested: Bool) {
        var candidates = cuOtherSpaceWindows(pid: pid).subtracting(known).subtracting(remote.keys)
        if !requested { candidates.subtract(unreachable) }
        guard !candidates.isEmpty else { return }
        // The main and focused windows answer directly from any Space, including windows the
        // app opened there and never listed, which no token reaches until they were vended.
        for attribute in ["AXMainWindow", "AXFocusedWindow"] {
            guard let window = cuElementAttribute(application, attribute), let number = cuWindowNumber(window), candidates.contains(number) else { continue }
            AXUIElementSetMessagingTimeout(window, cuAXTimeout)
            remote[number] = window
            candidates.remove(number)
        }
        guard !candidates.isEmpty else { return }
        let ceiling: UInt64 = requested ? cuRemoteTokenCeiling : 50_000
        if scanCursor >= ceiling { scanCursor = 0 }
        let result = cuScanRemoteTokens(pid: pid, wanted: candidates, from: scanCursor, ceiling: ceiling, deadline: min(deadline, cuNow() + 600_000_000))
        for (number, element) in result.found { remote[number] = element }
        scanCursor = result.next
        if result.next >= ceiling {
            // A whole pass missed these; they are not AX windows (helpers, overlays).
            unreachable.formUnion(candidates.subtracting(result.found.keys))
            scanCursor = 0
        }
    }
}

enum CURemoteSearch { case none, automatic, requested }

/// Uptime nanoseconds; engine deadlines are measured against it.
func cuNow() -> UInt64 { DispatchTime.now().uptimeNanoseconds }

struct CUServerWindow {
    let onScreen: Bool
    /// Global points, top-left origin.
    var frame: CGRect?
}

/// Window-server facts for specific windows, without listing every window on the Mac.
func cuServerWindowInfo(_ numbers: [CGWindowID]) -> [CGWindowID: CUServerWindow] {
    guard !numbers.isEmpty else { return [:] }
    var ids: [UnsafeRawPointer?] = numbers.map { UnsafeRawPointer(bitPattern: UInt($0)) }
    guard let array = CFArrayCreate(nil, &ids, ids.count, nil),
          let rows = CGWindowListCreateDescriptionFromArray(array) as? [[String: Any]] else { return [:] }
    var out: [CGWindowID: CUServerWindow] = [:]
    for row in rows {
        guard let number = (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value else { continue }
        let bounds = (row[kCGWindowBounds as String] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) }
        out[number] = CUServerWindow(onScreen: (row[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true, frame: bounds)
    }
    return out
}

/// This app's normal-layer windows that are on some Space other than the current one.
func cuOtherSpaceWindows(pid: pid_t) -> Set<CGWindowID> {
    let info = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    var offScreen: [CGWindowID] = []
    for row in info where (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid && (row[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 {
        guard let number = (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
              (row[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue != true,
              ((row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) > 0,
              let bounds = row[kCGWindowBounds as String] as? [String: Any],
              let height = (bounds["Height"] as? NSNumber)?.doubleValue, let width = (bounds["Width"] as? NSNumber)?.doubleValue,
              height >= 60, width >= 60 else { continue }
        offScreen.append(number)
    }
    return Set(offScreen.filter(cuWindowIsOnSomeSpace))
}

/// Whether the window server has the window on any Space. Ordered-out windows are on none.
/// Uses SkyLight's private space query; when it is unavailable every window counts.
func cuWindowIsOnSomeSpace(_ number: CGWindowID) -> Bool {
    typealias Connection = @convention(c) () -> Int32
    typealias Spaces = @convention(c) (Int32, Int32, CFArray) -> Unmanaged<CFArray>?
    guard let skyLight = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY),
          let connectionSymbol = dlsym(skyLight, "SLSMainConnectionID"),
          let spacesSymbol = dlsym(skyLight, "SLSCopySpacesForWindows") else { return true }
    let connection = unsafeBitCast(connectionSymbol, to: Connection.self)()
    let windows = [NSNumber(value: number)] as CFArray
    // Mask 7: current, other and full-screen Spaces.
    guard let spaces = unsafeBitCast(spacesSymbol, to: Spaces.self)(connection, 7, windows)?.takeRetainedValue() else { return false }
    return CFArrayGetCount(spaces) > 0
}

/// The window-server id of an AX window. Private but stable since macOS 10.x.
func cuWindowNumber(_ window: AXUIElement) -> CGWindowID? {
    typealias GetWindow = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow") else { return nil }
    var id: CGWindowID = 0
    return unsafeBitCast(symbol, to: GetWindow.self)(window, &id) == .success && id != 0 ? id : nil
}

let cuRemoteTokenCeiling: UInt64 = 200_000

/// Tries remote-token element ids from `from` upward until every wanted window is found, the
/// ceiling is reached or the deadline passes. `next` is where a later search resumes.
func cuScanRemoteTokens(pid: pid_t, wanted: Set<CGWindowID>, from: UInt64, ceiling: UInt64, deadline: UInt64) -> (found: [CGWindowID: AXUIElement], next: UInt64) {
    typealias Create = @convention(c) (CFData) -> Unmanaged<AXUIElement>?
    guard !wanted.isEmpty, let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementCreateWithRemoteToken") else { return ([:], from) }
    let create = unsafeBitCast(symbol, to: Create.self)
    var found: [CGWindowID: AXUIElement] = [:]
    var elementId = from
    var token = Data(count: 20)
    var lastFound: UInt64?
    while elementId < ceiling, found.count < wanted.count {
        if elementId % 64 == 0, cuNow() > deadline || cuRemoteScanIsPastWindows(lastFound: lastFound, next: elementId) { break }
        token.withUnsafeMutableBytes { bytes in
            bytes.storeBytes(of: pid, toByteOffset: 0, as: Int32.self)
            bytes.storeBytes(of: Int32(0), toByteOffset: 4, as: Int32.self)
            bytes.storeBytes(of: Int32(0x636f_636f), toByteOffset: 8, as: Int32.self)
            bytes.storeBytes(of: elementId, toByteOffset: 12, as: UInt64.self)
        }
        elementId += 1
        guard let element = create(token as CFData)?.takeRetainedValue() else { continue }
        guard cuRole(element) == "AXWindow", let number = cuWindowNumber(element), wanted.contains(number) else { continue }
        AXUIElementSetMessagingTimeout(element, cuAXTimeout)
        found[number] = element
        lastFound = elementId - 1
    }
    return (found, elementId)
}

/// Apps number their accessibility elements as they create them, and windows come early, so
/// once some windows are found a long run of ids without another one means the rest of the
/// wanted windows are not AX windows (helper and overlay windows). A later search for a
/// specific missing window resumes where this one stopped.
func cuRemoteScanIsPastWindows(lastFound: UInt64?, next: UInt64) -> Bool {
    guard let lastFound else { return false }
    return next > lastFound + max(2_000, lastFound * 4)
}
