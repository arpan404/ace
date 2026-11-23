import Foundation
import Testing
@testable import Ace

/// An organization's routes on the account backend, as the phone names them: an account id keeps
/// its `_` (the backend refuses a `%` in it), and anything that would leave the route is escaped
/// or refused.
struct OrganizationAdminTests {
    @Test func leaveAndRemoveNameAnAccountIdAsTheBackendKeepsIt() throws {
        #expect(try AceAccountAPI.orgPath("org_01ACME", "members", "user_01HZX") == "orgs/org_01ACME/members/user_01HZX")
    }

    @Test func anIdThatWouldLeaveTheRouteIsEscaped() throws {
        #expect(try AceAccountAPI.orgPath("org_01ACME", "members", "a/../b") == "orgs/org_01ACME/members/a%2F..%2Fb")
    }

    @Test func anOrganizationIdTheBackendNeverIssuesIsRefused() {
        #expect(throws: AceOrgError.refused("invalid")) { try AceAccountAPI.orgPath("../orgs", "members") }
        #expect(throws: AceOrgError.refused("invalid")) { try AceAccountAPI.orgPath("org_01ACME", "members", "") }
    }

    @Test func onlyOwnersGiveOwnerAndBillingSeesOnlyTheAuditLog() {
        #expect(OrgRoles.assignable(by: "owner") == ["member", "admin", "owner"])
        #expect(OrgRoles.assignable(by: "admin") == ["member", "admin"])
        #expect(OrgRoles.isAdmin("admin") && !OrgRoles.isAdmin("member") && !OrgRoles.isAdmin("billing"))
        #expect(OrgRoles.allows("billing", .auditRead) && !OrgRoles.allows("org_custom", .auditRead))
    }
}
