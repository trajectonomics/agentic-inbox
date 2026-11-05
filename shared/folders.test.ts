import { describe, expect, it } from "bun:test"
import { Folders, getFolderDisplayName, SYSTEM_FOLDER_IDS } from "./folders"

describe("folders", () => {
	it("exposes canonical folder constants", () => {
		expect(Folders.INBOX).toBe("inbox")
		expect(Folders.SENT).toBe("sent")
		expect(Folders.DRAFT).toBe("draft")
		expect(Folders.ARCHIVE).toBe("archive")
		expect(Folders.TRASH).toBe("trash")
		expect(Folders.SPAM).toBe("spam")
	})

	it("maintains expected sidebar order in SYSTEM_FOLDER_IDS without spam", () => {
		expect(SYSTEM_FOLDER_IDS).toEqual([
			Folders.INBOX,
			Folders.SENT,
			Folders.DRAFT,
			Folders.ARCHIVE,
			Folders.TRASH,
		])
		expect(SYSTEM_FOLDER_IDS.includes(Folders.SPAM as any)).toBe(false)
	})

	it("returns standard display names regardless of casing", () => {
		expect(getFolderDisplayName("inbox")).toBe("Inbox")
		expect(getFolderDisplayName("INBOX")).toBe("Inbox")
		expect(getFolderDisplayName("sent")).toBe("Sent")
		expect(getFolderDisplayName("draft")).toBe("Drafts")
	})

	it("capitalizes unknown custom folder IDs as fallback", () => {
		expect(getFolderDisplayName("receipts")).toBe("Receipts")
		expect(getFolderDisplayName("newsletter")).toBe("Newsletter")
	})
})
