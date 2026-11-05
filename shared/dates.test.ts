import { describe, expect, it } from "bun:test"
import { formatDetailDate, formatListDate, formatQuotedDate, formatShortDate } from "./dates"

describe("dates", () => {
	it("handles invalid or empty dates gracefully", () => {
		expect(formatListDate("invalid-date")).toBe("invalid-date")
		expect(formatDetailDate("not-a-date")).toBe("not-a-date")
		expect(formatShortDate("bogus")).toBe("bogus")
		expect(formatQuotedDate("")).toBe("")
		expect(formatQuotedDate(undefined)).toBe("")
	})

	it("formats list dates for today, current year, and past years", () => {
		const now = new Date()
		const todayIso = now.toISOString()
		expect(formatListDate(todayIso)).toMatch(/\d+:\d+/)

		const pastYearIso = "2020-05-10T12:00:00.000Z"
		expect(formatListDate(pastYearIso)).toContain("2020")
	})

	it("formats quoted date with deterministic en-US locale", () => {
		const fixedDate = "2026-04-15T15:42:00.000Z"
		const quoted = formatQuotedDate(fixedDate)
		expect(quoted).toContain("2026")
		expect(quoted).toMatch(/\d+:\d+/)
	})
})
