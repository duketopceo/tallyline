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

    func testAppleSignIn() throws {
        let apple = try decode(PairingRedeemResponse.self, "apple_sign_in")
        XCTAssertTrue(apple.token.hasPrefix("tly_pat_"))
        XCTAssertFalse(apple.workspace.slug.isEmpty)
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

final class RoadmapDecodeTests: XCTestCase {
    private func fixture(_ name: String) throws -> Data {
        let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures")
        return try Data(contentsOf: dir.appendingPathComponent("\(name).json"))
    }

    func testRoadmapSummaryDecodes() throws {
        let s = try APIClient.decoder.decode(RoadmapSummary.self, from: fixture("roadmap_summary"))
        XCTAssertEqual(s.totals.issues, 5)
        XCTAssertEqual(s.projects.first?.inProgress, 1)
        XCTAssertEqual(s.milestones.first?.done, 1)
        XCTAssertEqual(s.merges.first?.pr?.number, 251)
        XCTAssertEqual(s.merges.first?.actorType, "agent")
    }

    func testMissingProjectReadsAsZeroNotAbsent() throws {
        let s = try APIClient.decoder.decode(RoadmapSummary.self, from: fixture("roadmap_summary"))
        let known = s.counts(forProject: "5cf829ba-0b66-4168-b67b-48254bbb9873")
        XCTAssertEqual(known.total, 4)
        let absent = s.counts(forProject: "no-such-project")
        XCTAssertEqual(absent.total, 0)
        XCTAssertEqual(absent.done, 0)
        XCTAssertEqual(s.counts(forMilestone: "nope").total, 0)
    }

    func testMilestonesAndWiderProject() throws {
        let m = try APIClient.decoder.decode(MilestoneList.self, from: fixture("milestones")).milestones
        XCTAssertEqual(m.first?.title, "Beta")
        XCTAssertEqual(m.first?.progress?.total, 3)
        XCTAssertNotNil(m.first?.targetDate)
        let p = try APIClient.decoder.decode(ProjectList.self, from: fixture("projects")).projects
        XCTAssertNil(p.first?.targetDate)
        XCTAssertNotNil(p.first?.createdAt)
    }

    func testCreateAndPatchCarryEveryOptionalField() throws {
        let create = IssueCreate(title: "t", teamId: "tid", teamKey: "ENG", priority: .high, projectId: "p", cycleId: "c", assigneeType: "agent", assigneeId: "a", labelIds: ["l1", "l2"])
        let back = try JSONDecoder().decode(IssueCreate.self, from: JSONEncoder().encode(create))
        XCTAssertEqual(back, create)
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(create)) as? [String: Any]
        XCTAssertEqual(json?["teamKey"] as? String, "ENG")
        XCTAssertEqual(json?["labelIds"] as? [String], ["l1", "l2"])
        let bare = try JSONSerialization.jsonObject(with: JSONEncoder().encode(IssueCreate(title: "t", teamId: "x"))) as? [String: Any]
        XCTAssertNil(bare?["teamKey"])
        XCTAssertNil(bare?["labelIds"])

        let patch = IssuePatch(state: .todo, assigneeType: "agent", assigneeId: "a", projectId: "p", cycleId: "c", labelIds: ["l"])
        XCTAssertEqual(try JSONDecoder().decode(IssuePatch.self, from: JSONEncoder().encode(patch)), patch)
    }

    func testOutboxReplayKeepsEveryCreateProperty() async throws {
        let store = MemoryOutboxStore()
        let outbox = Outbox(store: store)
        let draft = IssueCreate(title: "x", teamId: "t", teamKey: "ENG", priority: .urgent, projectId: "p", cycleId: "c", assigneeType: "agent", assigneeId: "a", labelIds: ["l"])
        let entry = try await outbox.enqueue(.createIssue(draft), workspaceSlug: "acme")
        let reloaded = try store.load()
        XCTAssertEqual(reloaded, [entry])
        guard case .createIssue(let kept) = reloaded[0].operation else { return XCTFail("wrong operation") }
        XCTAssertEqual(kept, draft)
    }

    func testDisplayStates() async throws {
        let outbox = Outbox(store: MemoryOutboxStore())
        var entry = try await outbox.enqueue(.addComment(key: "ENG-1", body: "hi"), workspaceSlug: "acme")
        XCTAssertEqual(entry.displayState, .pending)
        entry.attempts = 2
        XCTAssertEqual(entry.displayState, .retrying)
        entry.status = .failed(reason: "no")
        XCTAssertEqual(entry.displayState, .parked)
    }

    func testAppliedPatchKeepsAssigneeType() {
        let issue = Issue(id: "1", key: "ENG-1", number: 1, title: "t", description: nil, state: .todo, priority: .none, estimate: nil, dueDate: nil, assigneeType: nil, assigneeId: nil, delegateType: nil, delegateId: nil, creatorType: "human", creatorId: nil, projectId: nil, cycleId: nil, parentId: nil, source: "web", occurrenceCount: 1, createdAt: Date(timeIntervalSince1970: 0), updatedAt: Date(timeIntervalSince1970: 0))
        XCTAssertEqual(issue.applying(IssuePatch(assigneeType: "agent", assigneeId: "a")).assigneeType, "agent")
        XCTAssertEqual(issue.applying(IssuePatch(assigneeId: "u")).assigneeType, "human")
    }
}
