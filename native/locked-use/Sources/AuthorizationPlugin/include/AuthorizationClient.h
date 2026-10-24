#import <Foundation/Foundation.h>

// The peer must validate the authorization transaction against an active, scoped permit.
// No control, installation, or generic unlock operation is exported on this interface.
@protocol ACELockedUseAuthorizing
- (void)authorizeAttempt:(NSString *)attempt
            transaction:(NSData *)transaction
                request:(NSString *)request
               deadline:(uint64_t)deadline
                  reply:(void (^)(BOOL allowed))reply;
@end

NSXPCConnection *ACERequestLockedUseAuthorization(NSString *attempt, NSData *transaction,
    NSString *request, uint64_t deadline, void (^reply)(BOOL allowed));
