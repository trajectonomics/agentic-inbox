import { describe, expect, it } from "bun:test"
import { parseSearchQuery } from "./search-parser"

describe("search-parser", () => {
	it("extracts plain free-text query without operators", () => {
		const parsed = parseSearchQuery("quarterly financial report")
		expect(parsed.query).toBe("quarterly financial report")
		expect(parsed.from).toBeUndefined()
		expect(parsed.folder).toBeUndefined()
	})

	it("parses single and multiple operators while preserving remaining text", () => {
		const parsed = parseSearchQuery("from:alice@example.com urgent issue in:inbox is:unread")
		expect(parsed.query).toBe("urgent issue")
		expect(parsed.from).toBe("alice@example.com")
		expect(parsed.folder).toBe("inbox")
		expect(parsed.is_read).toBe(false)
	})

	it("supports quoted operator values", () => {
		const parsed = parseSearchQuery('from:"Alice Smith" subject:"Budget 2026"')
		expect(parsed.from).toBe("Alice Smith")
		expect(parsed.subject).toBe("Budget 2026")
		expect(parsed.query).toBe("")
	})

	it("parses attachment and status flags correctly", () => {
		const parsed = parseSearchQuery("has:attachment is:starred")
		expect(parsed.has_attachment).toBe(true)
		expect(parsed.is_starred).toBe(true)
	})

	it("normalizes before and after dates to ISO format", () => {
		const parsed = parseSearchQuery("after:2026-01-01 before:2026-12-31")
		expect(parsed.date_start).toBeDefined()
		expect(parsed.date_start).toContain("2026-01-01")
		expect(parsed.date_end).toBeDefined()
		expect(parsed.date_end).toContain("2026-12-31")
	})
})
