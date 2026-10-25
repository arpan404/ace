#import <Foundation/Foundation.h>
#import <Security/AuthorizationPlugin.h>
#import <time.h>
#import "include/AuthorizationClient.h"

@interface ACEAuthorizationPlugin : NSObject
@property(nonatomic, assign) const AuthorizationCallbacks *callbacks;
@end
@implementation ACEAuthorizationPlugin
@end

@interface ACEAuthorizationMechanism : NSObject
@property(nonatomic, strong) ACEAuthorizationPlugin *plugin;
@property(nonatomic, assign) AuthorizationEngineRef engine;
@property(nonatomic, strong) NSRecursiveLock *lock;
@property(nonatomic, strong) NSXPCConnection *connection;
@property(nonatomic) BOOL active;
@property(nonatomic) BOOL reported;
@property(nonatomic) BOOL revoked;
@property(nonatomic) uint64_t deadline;
- (void)finish:(BOOL)allowed;
@end

@implementation ACEAuthorizationMechanism
- (void)finish:(BOOL)allowed {
    [self.lock lock];
    if (self.active && !self.reported && !self.revoked && self.engine) {
        self.reported = YES;
        BOOL timely = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) < self.deadline;
        self.plugin.callbacks->SetResult(self.engine, allowed && timely ? kAuthorizationResultAllow : kAuthorizationResultDeny);
    }
    NSXPCConnection *connection = self.connection;
    self.connection = nil;
    [self.lock unlock];
    [connection invalidate];
}
@end

static OSStatus ACEDestroyPlugin(AuthorizationPluginRef raw) {
    if (!raw) return errAuthorizationInternal;
    __unused ACEAuthorizationPlugin *plugin = CFBridgingRelease(raw);
    return errAuthorizationSuccess;
}

static OSStatus ACECreateMechanism(AuthorizationPluginRef raw, AuthorizationEngineRef engine,
    AuthorizationMechanismId name, AuthorizationMechanismRef *result) {
    if (!raw || !engine || !name || !result) return errAuthorizationInternal;
    *result = NULL;
    if (strcmp(name, "permit") != 0) return errAuthorizationInternal;
    ACEAuthorizationMechanism *mechanism = [ACEAuthorizationMechanism new];
    mechanism.plugin = (__bridge ACEAuthorizationPlugin *)raw;
    mechanism.engine = engine;
    mechanism.lock = [NSRecursiveLock new];
    *result = (AuthorizationMechanismRef)CFBridgingRetain(mechanism);
    return errAuthorizationSuccess;
}

static OSStatus ACEInvokeMechanism(AuthorizationMechanismRef raw) {
    if (!raw) return errAuthorizationInternal;
    ACEAuthorizationMechanism *mechanism = (__bridge ACEAuthorizationMechanism *)raw;
    [mechanism.lock lock];
    if (!mechanism.engine) { [mechanism.lock unlock]; return errAuthorizationInternal; }
    if (mechanism.active || mechanism.revoked) {
        mechanism.revoked = YES;
        mechanism.plugin.callbacks->SetResult(mechanism.engine, kAuthorizationResultDeny);
        [mechanism.lock unlock];
        return errAuthorizationSuccess;
    }
    mechanism.active = YES;
    const AuthorizationCallbacks *callbacks = mechanism.plugin.callbacks;
    AuthorizationSessionId transaction = NULL;
    const AuthorizationValue *hint = NULL;
    OSStatus transactionStatus = callbacks->GetSessionId(mechanism.engine, &transaction);
    OSStatus hintStatus = callbacks->GetImmutableHintValue(mechanism.engine, "dev.ace.locked-use.attempt", &hint);
    // AuthorizationSessionId is an opaque authorization transaction, NOT a GUI or audit
    // session id. Never cast it to SecuritySessionId or assume that it identifies a user.
    if (transactionStatus != errAuthorizationSuccess || !transaction || hintStatus != errAuthorizationSuccess ||
        !hint || !hint->data || hint->length == 0 || hint->length > 256) {
        [mechanism.lock unlock];
        [mechanism finish:NO];
        return errAuthorizationSuccess;
    }
    NSString *attempt = [[NSString alloc] initWithBytes:hint->data length:hint->length encoding:NSUTF8StringEncoding];
    NSCharacterSet *controls = [NSCharacterSet controlCharacterSet];
    if (!attempt || attempt.length == 0 || [attempt rangeOfCharacterFromSet:controls].location != NSNotFound) {
        [mechanism.lock unlock];
        [mechanism finish:NO];
        return errAuthorizationSuccess;
    }
    NSData *transactionData = [NSData dataWithBytes:&transaction length:sizeof(transaction)];
    NSString *request = [NSUUID UUID].UUIDString;
    uint64_t deadline = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) + 750 * NSEC_PER_MSEC;
    mechanism.deadline = deadline;
    mechanism.connection = ACERequestLockedUseAuthorization(attempt, transactionData, request, deadline, ^(BOOL allowed) {
        [mechanism finish:allowed];
    });
    [mechanism.lock unlock];
    // Bound the OS authorization decision even if the broker is unavailable or never replies.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 750 * NSEC_PER_MSEC), dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        [mechanism finish:NO];
    });
    return errAuthorizationSuccess;
}

static OSStatus ACEDeactivateMechanism(AuthorizationMechanismRef raw) {
    if (!raw) return errAuthorizationInternal;
    ACEAuthorizationMechanism *mechanism = (__bridge ACEAuthorizationMechanism *)raw;
    [mechanism.lock lock];
    mechanism.revoked = YES;
    mechanism.active = NO;
    NSXPCConnection *connection = mechanism.connection;
    mechanism.connection = nil;
    OSStatus status = mechanism.engine ? mechanism.plugin.callbacks->DidDeactivate(mechanism.engine) : errAuthorizationInternal;
    [mechanism.lock unlock];
    [connection invalidate];
    return status;
}

static OSStatus ACEDestroyMechanism(AuthorizationMechanismRef raw) {
    if (!raw) return errAuthorizationInternal;
    ACEAuthorizationMechanism *mechanism = CFBridgingRelease(raw);
    [mechanism.lock lock];
    mechanism.active = NO;
    mechanism.revoked = YES;
    mechanism.engine = NULL;
    NSXPCConnection *connection = mechanism.connection;
    mechanism.connection = nil;
    [mechanism.lock unlock];
    [connection invalidate];
    return errAuthorizationSuccess;
}

static const AuthorizationPluginInterface ACEInterface = {
    .version = kAuthorizationPluginInterfaceVersion,
    .PluginDestroy = ACEDestroyPlugin,
    .MechanismCreate = ACECreateMechanism,
    .MechanismInvoke = ACEInvokeMechanism,
    .MechanismDeactivate = ACEDeactivateMechanism,
    .MechanismDestroy = ACEDestroyMechanism,
};

__attribute__((visibility("default")))
OSStatus AuthorizationPluginCreate(const AuthorizationCallbacks *callbacks, AuthorizationPluginRef *plugin,
    const AuthorizationPluginInterface **interface) {
    if (plugin) *plugin = NULL;
    if (interface) *interface = NULL;
    if (!callbacks || !plugin || !interface || callbacks->version < kAuthorizationCallbacksVersion ||
        !callbacks->SetResult || !callbacks->DidDeactivate || !callbacks->GetSessionId || !callbacks->GetImmutableHintValue) {
        return errAuthorizationInternal;
    }
    ACEAuthorizationPlugin *instance = [ACEAuthorizationPlugin new];
    instance.callbacks = callbacks;
    *plugin = (AuthorizationPluginRef)CFBridgingRetain(instance);
    *interface = &ACEInterface;
    return errAuthorizationSuccess;
}
