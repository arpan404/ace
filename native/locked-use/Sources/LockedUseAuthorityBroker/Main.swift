import Foundation
import Darwin
import LockedUseBrokerKit
import LockedUseIPC
import LockedUseSystem

// Root launch daemon, signed as `dev.ace.locked-use.authority` (the identifier the plug-in pins).
// It owns the plug-in-facing Mach service and the coordinator registration service; launchd
// registers both names at install time. It never arms, enables or unlocks anything itself.
setvbuf(stderr, nil, _IONBF, 0)
let requirement: String
let daemonRequirement: String
do {
    requirement = try lockedUsePeerRequirement(identifier: LockedUseNames.serviceIdentifier)
    daemonRequirement = try lockedUseTeamRequirement(team: lockedUseOwnTeam())
} catch {
    FileHandle.standardError.write(Data("ace-locked-use-authority: refusing to start without a team-signed executable (\(error))\n".utf8))
    exit(78)
}
let now: () -> UInt64 = { clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) }
// The coordinator must have been spawned by ace-signed code (the daemon's runtime), not by
// whatever same-user process ran its own copy of the signed screen helper.
let broker = LockedUseAuthorityBroker(listener: NSXPCListener(machServiceName: LockedUseNames.brokerService),
    requirement: requirement, now: now,
    vetAncestry: { pid in
        lockedUseVetAncestry(child: pid, read: lockedUseReadProcessFacts,
            trusted: { lockedUseProcessSatisfies($0, requirement: daemonRequirement) })
    },
    refused: { refusal, pid in
        FileHandle.standardError.write(Data("ace-locked-use-authority: refused coordinator pid \(pid): \(refusal)\n".utf8))
    })
let endpoint = LockedUseAuthorizationEndpoint(listener: NSXPCListener(machServiceName: LockedUseNames.authorizationService),
    now: now, verify: broker.forward)
broker.start()
endpoint.start()
dispatchMain()
