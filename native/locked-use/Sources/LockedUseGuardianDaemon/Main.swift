import Foundation
import Darwin
import LockedUseGuardianKit
import LockedUseSystem

// The launch daemon registers `dev.ace.locked-use.guardian` at install time. This process
// holds no state on disk: if it restarts, armed attempts are lost, and the GUI service's
// guardian link sees the drop and stops work (its covers stay until a confirmed lock).
setvbuf(stderr, nil, _IONBF, 0)
let requirement: String
do { requirement = try lockedUsePeerRequirement(identifier: LockedUseNames.serviceIdentifier) }
catch {
    FileHandle.standardError.write(Data("ace-locked-use-guardian: refusing to start without a team-signed executable (\(error))\n".utf8))
    exit(78)
}
let server = LockedUseGuardianServer(listener: NSXPCListener(machServiceName: LockedUseNames.guardianService),
    requirement: requirement, lock: LockedUseDisplaySleepLock(), now: { clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) },
    events: { event in FileHandle.standardError.write(Data("ace-locked-use-guardian: \(event)\n".utf8)) })
let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "dev.ace.locked-use.guardian.timer"))
timer.schedule(deadline: .now(), repeating: .milliseconds(100), leeway: .milliseconds(10))
timer.setEventHandler { server.tick() }
timer.resume()
server.start()
dispatchMain()
