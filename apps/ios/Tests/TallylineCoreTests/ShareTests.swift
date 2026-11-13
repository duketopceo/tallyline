import XCTest
@testable import TallylineCore

final class ShareComposerTests: XCTestCase {
    func testTextBecomesTitleAndBody() throws {
        let d = try XCTUnwrap(ShareComposer.draft(text: "\n  Login button is grey  \nSteps: tap it\nNothing happens", url: nil, teamId: "t1"))
        XCTAssertEqual(d.title, "Login button is grey")
        XCTAssertEqual(d.description, "Steps: tap it\nNothing happens")
        XCTAssertEqual(d.state, .triage)
        XCTAssertEqual(d.teamId, "t1")
    }

    func testBareLinkUsesHostAndPath() throws {
        let url = URL(string: "https://www.example.com/docs/setup?x=1")!
        let d = try XCTUnwrap(ShareComposer.draft(text: nil, url: url, teamId: "t1"))
        XCTAssertEqual(d.title, "example.com/docs/setup")
        XCTAssertEqual(d.description, url.absoluteString)
    }

    func testLinkIsAppendedOnceUnderText() throws {
        let url = URL(string: "https://example.com/a")!
        XCTAssertEqual(ShareComposer.draft(text: "Read this", url: url, teamId: "t")?.description, "https://example.com/a")
        XCTAssertNil(ShareComposer.draft(text: "Read https://example.com/a", url: url, teamId: "t")?.description)
    }

    func testLongTitleIsShortenedAndKeptInFull() throws {
        let long = String(repeating: "word ", count: 40).trimmingCharacters(in: .whitespaces)
        let d = try XCTUnwrap(ShareComposer.draft(text: long, url: nil, teamId: "t"))
        XCTAssertLessThanOrEqual(d.title.count, ShareComposer.titleLimit)
        XCTAssertTrue(d.title.hasSuffix("…"))
        XCTAssertEqual(d.description, long)
    }

    func testNothingToFile() {
        XCTAssertNil(ShareComposer.draft(text: "  \n ", url: nil, teamId: "t"))
    }

    func testTriageStateIsSentAndUnsetStateIsOmitted() throws {
        let withState = try JSONSerialization.jsonObject(with: JSONEncoder().encode(IssueCreate(title: "a", teamId: "t", state: .triage))) as? [String: Any]
        XCTAssertEqual(withState?["state"] as? String, "triage")
        let without = try JSONSerialization.jsonObject(with: JSONEncoder().encode(IssueCreate(title: "a", teamId: "t"))) as? [String: Any]
        XCTAssertNil(without?["state"])
    }
}

final class ShareInboxTests: XCTestCase {
    func testAddListRemoveOldestFirst() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let inbox = ShareInbox(directory: dir)
        XCTAssertEqual(inbox.pending(), [])
        let newer = SharedDraft(id: "b", workspaceSlug: "acme", draft: IssueCreate(title: "two", teamId: "t"), createdAt: Date(timeIntervalSince1970: 20))
        let older = SharedDraft(id: "a", workspaceSlug: "acme", draft: IssueCreate(title: "one", teamId: "t", state: .triage), createdAt: Date(timeIntervalSince1970: 10))
        try inbox.add(newer)
        try inbox.add(older)
        try Data("not json".utf8).write(to: dir.appendingPathComponent("junk.json"))
        XCTAssertEqual(inbox.pending(), [older, newer])
        inbox.remove("a")
        XCTAssertEqual(inbox.pending().map(\.id), ["b"])
    }

    func testUnsafeIdIsRefusedAndCannotEscapeTheInbox() throws {
        let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let dir = parent.appendingPathComponent("inbox", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: parent) }
        let inbox = ShareInbox(directory: dir)
        let secret = parent.appendingPathComponent("secret")
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        try Data("keep".utf8).write(to: secret)

        XCTAssertFalse(ShareInbox.isSafeId("../secret"))
        XCTAssertFalse(ShareInbox.isSafeId("a/b"))
        XCTAssertThrowsError(try inbox.add(SharedDraft(id: "../secret", workspaceSlug: "acme", draft: IssueCreate(title: "x", teamId: "t")))) { error in
            XCTAssertEqual(error as? ShareInboxError, .unsafeId)
        }

        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let planted = SharedDraft(id: "../secret", workspaceSlug: "acme", draft: IssueCreate(title: "x", teamId: "t"), createdAt: Date(timeIntervalSince1970: 1))
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(planted).write(to: dir.appendingPathComponent("evil.json"))
        XCTAssertEqual(inbox.pending(), [])
        inbox.remove("../secret")
        XCTAssertEqual(try String(contentsOf: secret, encoding: .utf8), "keep")

        try Data("junk".utf8).write(to: dir.appendingPathComponent("junk.txt"))
        inbox.removeAll()
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil), [])
        XCTAssertEqual(try String(contentsOf: secret, encoding: .utf8), "keep")
    }

    func testClaimEnqueuesOnceAndLeavesTheFileWhenSaveFails() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let inbox = ShareInbox(directory: dir)
        let draft = IssueCreate(title: "Login button", teamId: "t1", state: .triage)
        let item = SharedDraft(id: "share-1", workspaceSlug: "acme", draft: draft, createdAt: Date(timeIntervalSince1970: 5))
        try inbox.add(item)

        let store = ThrowingOutboxStore()
        store.shouldThrow = true
        let outbox = Outbox(store: store, now: { Date(timeIntervalSince1970: 1_800_000_000) })
        let removed = await ShareIntake.claim(inbox: inbox, outbox: outbox)
        XCTAssertEqual(removed, 0)
        XCTAssertEqual(inbox.pending().map(\.id), ["share-1"])
        let queued = await outbox.all
        XCTAssertTrue(queued.isEmpty)

        store.shouldThrow = false
        let claimed = await ShareIntake.claim(inbox: inbox, outbox: outbox)
        XCTAssertEqual(claimed, 1)
        XCTAssertTrue(inbox.pending().isEmpty)
        let entries = await outbox.all
        XCTAssertEqual(entries.map(\.id), ["share-1"])
        XCTAssertEqual(entries.first?.workspaceSlug, "acme")
        guard case .createIssue(let saved) = entries.first?.operation else {
            return XCTFail("expected a create")
        }
        XCTAssertEqual(saved.title, "Login button")
        XCTAssertEqual(saved.teamId, "t1")

        try inbox.add(item)
        let reclaimed = await ShareIntake.claim(inbox: inbox, outbox: outbox)
        XCTAssertEqual(reclaimed, 1)
        let again = await outbox.all
        XCTAssertEqual(again.map(\.id), ["share-1"])
    }

    func testTeamMemoryCachesTheTeamList() throws {
        let suite = "tally-test-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let memory = TeamMemory(defaults: defaults)
        XCTAssertTrue(memory.teams.isEmpty)
        memory.teams = [Team(id: "t1", name: "Core", key: "ENG")]
        XCTAssertEqual(memory.teams.map(\.key), ["ENG"])
    }
}

private final class ThrowingOutboxStore: OutboxStore, @unchecked Sendable {
    var saved: [OutboxEntry] = []
    var shouldThrow = false
    func load() throws -> [OutboxEntry] { saved }
    func save(_ entries: [OutboxEntry]) throws {
        if shouldThrow { throw ShareInboxError.unsafeId }
        saved = entries
    }
}
