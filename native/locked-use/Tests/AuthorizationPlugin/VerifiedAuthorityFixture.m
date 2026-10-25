#import "../../Sources/AuthorizationPlugin/include/AuthorizationClient.h"

// Test boundary only. Production build.sh never links this file. Simulates a verified
// authority decision so the OS callback lifecycle can be tested in both directions.
NSXPCConnection *ACERequestLockedUseAuthorization(NSString *attempt, NSData *transaction,
    NSString *request, uint64_t deadline, void (^reply)(BOOL allowed)) {
    (void)attempt; (void)transaction; (void)request; (void)deadline;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ reply(YES); reply(YES); });
    return nil;
}
