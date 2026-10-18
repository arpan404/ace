import ApplicationServices
import Darwin

/// Tells one app that one of its windows is now its key window, without activating the app
/// or raising the window. The window server keeps routing the person's keyboard to their
/// frontmost app; only the target app updates its own key window, so its menus, shortcuts
/// and first responder work as if it were in front.
///
/// The window server accepts focus event records for a process through SkyLight's private
/// `SLPSPostEventRecordTo`. A record is 0xf8 bytes: its length at 0x04, the event kind at 0x08
/// (1 = focus gained, 2 = key window changed), 0x10 at 0x3a and the window id at 0x3c.
func cuFocusWithoutActivating(pid: pid_t, window: CGWindowID) -> Bool {
    typealias ProcessForPID = @convention(c) (pid_t, UnsafeMutablePointer<ProcessSerialNumber>) -> OSStatus
    typealias PostRecord = @convention(c) (UnsafeMutablePointer<ProcessSerialNumber>, UnsafeMutablePointer<UInt8>) -> CGError
    guard let skyLight = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY),
          let postSymbol = dlsym(skyLight, "SLPSPostEventRecordTo"),
          let processSymbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "GetProcessForPID") else { return false }
    var process = ProcessSerialNumber()
    guard unsafeBitCast(processSymbol, to: ProcessForPID.self)(pid, &process) == noErr else { return false }
    let post = unsafeBitCast(postSymbol, to: PostRecord.self)
    var record = [UInt8](repeating: 0, count: 0xf8)
    record[0x04] = 0xf8
    record[0x3a] = 0x10
    withUnsafeBytes(of: window.littleEndian) { bytes in for (offset, byte) in bytes.enumerated() { record[0x3c + offset] = byte } }
    for offset in 0x20..<0x30 { record[offset] = 0xff }
    record[0x08] = 0x01
    let gained = post(&process, &record)
    record[0x08] = 0x02
    let changed = post(&process, &record)
    return gained == .success && changed == .success
}
