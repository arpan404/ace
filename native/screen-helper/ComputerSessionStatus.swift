import CoreGraphics

/// An unavailable GUI session must never be interpreted as an unlocked desktop.
enum CUSessionStatus: String { case active, locked, unavailable }

func cuSessionStatus(onConsole: Bool?, loginDone: Bool?, locked: Bool?) -> CUSessionStatus {
    guard onConsole == true, loginDone == true else { return .unavailable }
    if locked == true { return .locked }
    return .active
}

func cuSessionStatus() -> CUSessionStatus {
    guard let values = CGSessionCopyCurrentDictionary() as? [String: Any] else { return .unavailable }
    if values["CGSSessionScreenIsLocked"] != nil, values["CGSSessionScreenIsLocked"] as? Bool == nil { return .unavailable }
    // macOS omits the existing lock-screen flag while unlocked. It is a best-effort
    // signal, not a documented CGSession key; public console/login facts must also hold.
    return cuSessionStatus(onConsole: values[kCGSessionOnConsoleKey as String] as? Bool,
        loginDone: values[kCGSessionLoginDoneKey as String] as? Bool,
        locked: values["CGSSessionScreenIsLocked"] as? Bool)
}

let cuSessionUnavailableError = CUError("session_unavailable", "The Mac's GUI session is unavailable. Stop computer actions until the person's desktop session returns, then observe again. Other tools can continue.")
let cuLockedControlsError = CUError("screen_locked", "The Mac is locked and macOS is not exposing this app's window controls. Do not retry these element ids or open replacement windows. Continue with browser or other non-GUI tools where available; observe again after the person unlocks the Mac.")

func cuRequirePostedInput(_ status: CUSessionStatus) throws {
    switch status {
    case .active: return
    case .locked: throw CUError("screen_locked", "The Mac is locked. Posted keyboard and mouse events cannot be confirmed. Use an available accessibility action or another tool; observe again after unlocking.")
    case .unavailable: throw cuSessionUnavailableError
    }
}
