#import <Foundation/Foundation.h>
#import <Security/AuthorizationPlugin.h>
#import <dlfcn.h>

static NSMutableArray<NSNumber *> *decisions;
static BOOL hasHint;
static BOOL sessionAvailable = YES;
static NSUInteger hintMode;
static NSUInteger deactivations;
static OSStatus result(AuthorizationEngineRef engine, AuthorizationResult value) {
    (void)engine;
    @synchronized(decisions) { [decisions addObject:@(value)]; }
    return errAuthorizationSuccess;
}
static OSStatus deactivated(AuthorizationEngineRef engine) {
    (void)engine;
    deactivations++;
    return errAuthorizationSuccess;
}
static OSStatus session(AuthorizationEngineRef engine, AuthorizationSessionId *value) {
    (void)engine;
    *value = sessionAvailable ? (AuthorizationSessionId)(uintptr_t)0x12345678 : NULL;
    return errAuthorizationSuccess;
}
static OSStatus hint(AuthorizationEngineRef engine, AuthorizationString key, const AuthorizationValue **value) {
    (void)engine;
    static const char attempt[] = "fixture-attempt-not-a-live-permit";
    static const AuthorizationValue contents = { sizeof(attempt) - 1, (void *)attempt };
    if (!hasHint || strcmp(key, "dev.ace.locked-use.attempt") != 0) { *value = NULL; return errAuthorizationDenied; }
    static const char invalid[] = { (char)0xff };
    static const char control[] = { 'a', '\n' };
    static const char oversized[257] = {0};
    static const AuthorizationValue badUTF8 = { sizeof(invalid), (void *)invalid };
    static const AuthorizationValue badControl = { sizeof(control), (void *)control };
    static const AuthorizationValue tooLarge = { sizeof(oversized), (void *)oversized };
    *value = hintMode == 1 ? &badUTF8 : hintMode == 2 ? &badControl : hintMode == 3 ? &tooLarge : &contents;
    return errAuthorizationSuccess;
}
static void require(BOOL condition, NSString *message) {
    if (!condition) { fprintf(stderr, "%s\n", message.UTF8String); exit(1); }
}
static NSUInteger count(void) { @synchronized(decisions) { return decisions.count; } }
static void runFor(NSTimeInterval seconds) {
    NSDate *end = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (end.timeIntervalSinceNow > 0) { [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]]; }
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        require(argc == 2 || argc == 3, @"Pass the built bundle executable");
        BOOL verifiedAuthority = argc == 3;
        decisions = [NSMutableArray new];
        void *binary = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
        require(binary != NULL, @"Built authorization component could not load");
        typedef OSStatus (*Create)(const AuthorizationCallbacks *, AuthorizationPluginRef *, const AuthorizationPluginInterface **);
        Create create = (Create)dlsym(binary, "AuthorizationPluginCreate");
        require(create != NULL, @"The OS could not load the plug-in ABI");
        AuthorizationCallbacks callbacks = {0};
        callbacks.version = kAuthorizationCallbacksVersion;
        callbacks.SetResult = result;
        callbacks.DidDeactivate = deactivated;
        callbacks.GetSessionId = session;
        callbacks.GetImmutableHintValue = hint;
        AuthorizationPluginRef plugin = NULL;
        const AuthorizationPluginInterface *api = NULL;
        require(create(&callbacks, &plugin, &api) == errAuthorizationSuccess, @"Engine initialization failed");
        AuthorizationMechanismRef mechanism = NULL;
        AuthorizationEngineRef engine = (AuthorizationEngineRef)(uintptr_t)0x76543210;
        require(api->MechanismCreate(plugin, engine, "not-our-mechanism", &mechanism) != errAuthorizationSuccess, @"Unknown mechanisms must never run");
        require(mechanism == NULL, @"Rejected mechanism left a live reference");
        require(api->MechanismCreate(plugin, engine, "permit", &mechanism) == errAuthorizationSuccess, @"Could not instantiate engine mechanism");
        hasHint = NO;
        require(api->MechanismInvoke(mechanism) == errAuthorizationSuccess, @"No-hint invocation failed to return a decision");
        require(count() == 1 && decisions.firstObject.unsignedIntValue == kAuthorizationResultDeny, @"Missing transaction binding did not deny");
        api->MechanismDestroy(mechanism);
        @synchronized(decisions) { [decisions removeAllObjects]; }
        hasHint = YES;
        for (NSUInteger mode = 1; mode <= 4; mode++) {
            hintMode = mode;
            sessionAvailable = mode != 4;
            require(api->MechanismCreate(plugin, engine, "permit", &mechanism) == errAuthorizationSuccess, @"Could not instantiate malformed-binding mechanism");
            api->MechanismInvoke(mechanism);
            require(count() == 1 && decisions.firstObject.unsignedIntValue == kAuthorizationResultDeny, @"Malformed attempt or absent transaction did not deny");
            api->MechanismDestroy(mechanism);
            @synchronized(decisions) { [decisions removeAllObjects]; }
        }
        hintMode = 0;
        sessionAvailable = YES;
        require(api->MechanismCreate(plugin, engine, "permit", &mechanism) == errAuthorizationSuccess, @"Could not instantiate pending mechanism");
        NSDate *started = [NSDate date];
        api->MechanismInvoke(mechanism);
        while (count() == 0 && -started.timeIntervalSinceNow < 1.5) { runFor(0.01); }
        AuthorizationResult expected = verifiedAuthority ? kAuthorizationResultAllow : kAuthorizationResultDeny;
        require(count() == 1 && decisions.firstObject.unsignedIntValue == expected, @"Authority decision did not reach the engine within its deadline");
        runFor(0.85);
        require(count() == 1, @"Timeout or duplicate connection replies changed the engine decision");
        api->MechanismDestroy(mechanism);
        @synchronized(decisions) { [decisions removeAllObjects]; }
        require(api->MechanismCreate(plugin, engine, "permit", &mechanism) == errAuthorizationSuccess, @"Could not instantiate interrupted mechanism");
        api->MechanismInvoke(mechanism);
        api->MechanismDeactivate(mechanism);
        require(deactivations == 1, @"Engine deactivation was not acknowledged");
        NSUInteger completedAtDeactivate = count();
        api->MechanismDestroy(mechanism);
        api->PluginDestroy(plugin);
        runFor(0.85);
        require(count() == completedAtDeactivate, @"A destroyed mechanism sent a late engine decision");
        for (NSNumber *decision in decisions) { require(decision.unsignedIntValue != kAuthorizationResultAllow, @"Unbound request unexpectedly authorized"); }
        puts(verifiedAuthority ? "PASS: a verified boundary grant is reported once; cancellation and destruction suppress late grants" : "PASS: missing bindings, unknown mechanisms, absent authority, timeout, duplicate replies, deactivation and destruction fail closed");
        // Pending dispatch blocks execute plug-in code. Let process teardown unload the
        // image instead of dlclose while those callbacks might still be queued.
        return 0;
    }
}
