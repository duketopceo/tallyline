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
