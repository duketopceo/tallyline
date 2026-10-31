import XCTest
@testable import TallylineCore

final class IssueKeyTests: XCTestCase {
    func testNormalizesTypedAndSpokenKeys() {
        XCTAssertEqual(IssueKey.normalize("ENG-12"), "ENG-12")
        XCTAssertEqual(IssueKey.normalize(" eng 12 "), "ENG-12")
        XCTAssertEqual(IssueKey.normalize("eng12"), "ENG-12")
        XCTAssertEqual(IssueKey.normalize("ios_7"), "IOS-7")
        XCTAssertEqual(IssueKey.normalize("a1-7"), "A1-7")
    }

    func testRejectsNonKeys() {
        for text in ["", "ENG", "12", "ENG-", "ENG-012", "ENG-1-2", "1ENG-2", "ÉNG-1", "ENG-1a", "TOOLONGTEAMKEY-1", "ENG-1234567890"] {
            XCTAssertNil(IssueKey.normalize(text), text)
        }
    }

    func testTeamMemoryFallsBackToTheFirstTeam() throws {
        let suite = "tally-test-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let memory = TeamMemory(defaults: defaults)
        let teams = [Team(id: "t1", name: "Core", key: "ENG"), Team(id: "t2", name: "Apps", key: "APP")]
        XCTAssertEqual(memory.pick(from: teams)?.id, "t1")
        memory.teamId = "t2"
        XCTAssertEqual(memory.pick(from: teams)?.id, "t2")
        memory.teamId = "gone"
        XCTAssertEqual(memory.pick(from: teams)?.id, "t1")
        XCTAssertNil(memory.pick(from: []))
    }
}
