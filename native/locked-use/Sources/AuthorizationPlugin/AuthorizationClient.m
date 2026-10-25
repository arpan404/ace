#import "include/AuthorizationClient.h"
#import "LockedUseSigning.h"

NSXPCConnection *ACERequestLockedUseAuthorization(NSString *attempt, NSData *transaction,
    NSString *request, uint64_t deadline, void (^reply)(BOOL allowed)) {
    NSXPCConnection *connection = [[NSXPCConnection alloc]
        initWithMachServiceName:@"dev.ace.locked-use.authorization" options:NSXPCConnectionPrivileged];
    connection.remoteObjectInterface = [NSXPCInterface interfaceWithProtocol:@protocol(ACELockedUseAuthorizing)];
    NSString *requirement = [NSString stringWithFormat:
        @"anchor apple generic and certificate leaf[subject.OU] = \"%@\" and identifier = \"dev.ace.locked-use.authority\"", @ACE_LOCKED_USE_TEAM];
    [connection setCodeSigningRequirement:requirement];
    connection.interruptionHandler = ^{ reply(NO); };
    connection.invalidationHandler = ^{ reply(NO); };
    [connection resume];
    id<ACELockedUseAuthorizing> proxy = [connection remoteObjectProxyWithErrorHandler:^(NSError *error) {
        (void)error;
        reply(NO);
    }];
    [proxy authorizeAttempt:attempt transaction:transaction request:request deadline:deadline reply:reply];
    return connection;
}
