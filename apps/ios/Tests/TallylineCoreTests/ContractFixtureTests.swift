import Foundation
import XCTest
@testable import TallylineCore

/// Decodes JSON captured from the real API routes (apps/api
/// src/routes/ios-contract.test.ts writes these and fails when they drift).
final class ContractFixtureTests: XCTestCase {
    private func fixture(_ name: String) throws -> Data {
        let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures")
        return try Data(contentsOf: dir.appendingPathComponent("\(name).json"))
    }

    private func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try APIClient.decoder.decode(T.self, from: fixture(name))
    }

    func testDatesWithMilliseconds() {
        XCTAssertNotNil(APIDate.parse("2026-10-30T23:39:51.452Z"))
        XCTAssertNotNil(APIDate.parse("2026-10-30T23:39:51Z"))
        XCTAssertNil(APIDate.parse("yesterday"))
        let d = Date(timeIntervalSince1970: 1_800_000_000.123)
        XCTAssertEqual(APIDate.parse(APIDate.format(d))?.timeIntervalSince1970 ?? 0, d.timeIntervalSince1970, accuracy: 0.001)
    }

    func testPairingAndWhoami() throws {
        let pair = try decode(PairingRedeemResponse.self, "pair_redeem")
        XCTAssertTrue(pair.token.hasPrefix("tly_pat_"))
        let me = try decode(Whoami.self, "whoami")
        XCTAssertEqual(me.memberships.first?.workspaceSlug, pair.workspace.slug)
    }

    func testIssues() throws {
        let list = try decode(IssuePage.self, "issues_list")
        XCTAssertEqual(list.issues.first?.state, .triage)
        XCTAssertEqual(list.issues.first?.priority, .high)
        XCTAssertNotNil(list.issues.first?.dueDate)
        _ = try decode(IssuePage.self, "issues_delta")
        _ = try decode(Issue.self, "issue_detail")
        let created = try decode(Issue.self, "issue_create")
        XCTAssertEqual(created.title, "From the phone")
        XCTAssertEqual(try decode(Issue.self, "issue_patch").state, .todo)
    }

    func testComments() throws {
        XCTAssertEqual(try decode(IssueComment.self, "comment_create").body, "Looks right")
        XCTAssertEqual(try decode(CommentList.self, "comments_list").comments.count, 1)
    }

    func testPickers() throws {
        XCTAssertFalse(try decode(TeamList.self, "teams").teams.isEmpty)
        XCTAssertNotNil(try decode(ProjectList.self, "projects").projects.first?.status)
        XCTAssertFalse(try decode(CycleList.self, "cycles").cycles.isEmpty)
        XCTAssertFalse(try decode(LabelList.self, "labels").labels.isEmpty)
        XCTAssertFalse(try decode(MemberList.self, "members").members.isEmpty)
    }

    func testReviewQueue() throws {
        let q = try decode(ReviewQueueList.self, "review_queue").queue
        XCTAssertEqual(q.count, 1)
        XCTAssertFalse(q[0].agentName.isEmpty)
    }
}
