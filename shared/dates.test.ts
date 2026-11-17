import { describe, expect, it } from "bun:test"
import {
	formatDetailDate,
	formatListDate,
	formatQuotedDate,
	formatShortDate,
	normalizeIsoDateBound,
} from "./dates"

describe("date formatting", () => {
	it("returns raw input on unparseable list dates", () => {
		expect(formatListDate("invalid-date")).toBe("invalid-date")
	})

	it("returns raw input on unparseable detail and short dates", () => {
		expect(formatDetailDate("not-a-date")).toBe("not-a-date")
		expect(formatShortDate("bogus")).toBe("bogus")
	})

	it("returns empty string on empty quoted dates", () => {
		expect(formatQuotedDate("")).toBe("")
		expect(formatQuotedDate(undefined)).toBe("")
	})

	it("formats email rows received today with time only", () => {
		const now = new Date()
		const todayLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 30).toString()
		expect(formatListDate(todayLocal)).toMatch(/\d+:\d+/)
	})

	it("formats email rows from earlier in the current year with month and day", () => {
		const now = new Date()
		const pastMonth = now.getMonth() === 0 ? 11 : now.getMonth() - 1
		const pastYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()
		const earlierThisYear = new Date(pastYear, pastMonth, 15).toString()
		const formatted = formatListDate(earlierThisYear)
		if (pastYear === now.getFullYear()) {
			expect(formatted).not.toContain(String(now.getFullYear()))
		}
	})

	it("formats older email rows from previous years with the year included", () => {
		const olderDate = new Date(2021, 5, 20).toString()
		expect(formatListDate(olderDate)).toContain("2021")
	})

	it("formats quoted reply dates with deterministic en-US calendar timestamp", () => {
		const fixedDate = new Date(Date.UTC(2026, 3, 15, 15, 42, 0)).toISOString()
		const quoted = formatQuotedDate(fixedDate)
		expect(quoted).toContain("2026")
		expect(quoted).toMatch(/\d+:\d+/)
	})
})

describe("date bounds for a stored timestamp", () => {
	it("starts a date-only lower bound at the beginning of its day", () => {
		expect(normalizeIsoDateBound("2026-11-01", "start")).toBe("2026-11-01T00:00:00.000Z")
	})

	it("ends a date-only upper bound at the last millisecond of its day", () => {
		expect(normalizeIsoDateBound("2026-11-17", "end")).toBe("2026-11-17T23:59:59.999Z")
	})

	it("leaves a bound that already carries a time alone", () => {
		expect(normalizeIsoDateBound("2026-11-17T09:30:00.000Z", "end")).toBe(
			"2026-11-17T09:30:00.000Z",
		)
	})

	it("leaves an absent bound absent", () => {
		expect(normalizeIsoDateBound(undefined, "start")).toBeUndefined()
	})
})
