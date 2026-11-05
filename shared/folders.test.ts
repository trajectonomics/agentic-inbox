import { describe, expect, it } from "bun:test"
import { Folders, getFolderDisplayName, SYSTEM_FOLDER_IDS } from "./folders"

describe("folders domain model", () => {
	it("exposes canonical system folder identifiers", () => {
		expect(Folders.INBOX).toBe("inbox")
		expect(Folders.SENT).toBe("sent")
		expect(Folders.DRAFT).toBe("draft")
		expect(Folders.ARCHIVE).toBe("archive")
		expect(Folders.TRASH).toBe("trash")
		expect(Folders.SPAM).toBe("spam")
	})

	it("excludes spam from standard sidebar navigation ordering", () => {
		expect(SYSTEM_FOLDER_IDS).toEqual([
			Folders.INBOX,
			Folders.SENT,
			Folders.DRAFT,
			Folders.ARCHIVE,
			Folders.TRASH,
		])
		const folderIds: readonly string[] = SYSTEM_FOLDER_IDS
		expect(folderIds.includes(Folders.SPAM)).toBe(false)
	})

	it("normalizes mixed-case folder identifiers to standard display titles", () => {
		expect(getFolderDisplayName("inbox")).toBe("Inbox")
		expect(getFolderDisplayName("INBOX")).toBe("Inbox")
		expect(getFolderDisplayName("sent")).toBe("Sent")
		expect(getFolderDisplayName("draft")).toBe("Drafts")
	})

	it("capitalizes user-defined custom folder names as fallback", () => {
		expect(getFolderDisplayName("receipts")).toBe("Receipts")
		expect(getFolderDisplayName("newsletter")).toBe("Newsletter")
	})
})
