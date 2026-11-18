import { describe, expect, it } from "bun:test"
import { attachmentDeleteErrorMessage } from "./attachments"
import { deleteFolderAndFiles } from "./delete"
import { fakeDeleteEnv, receipt } from "./delete-fakes"

describe("deleting a Folder", () => {
	it("removes its Messages' Attachment objects before the Folder's rows", async () => {
		const { env, order } = fakeDeleteEnv({ folder: { isDeletable: true, attachments: [receipt] } })

		expect(await deleteFolderAndFiles(env, "me@example.com", "f1")).toEqual({
			status: "deleted",
			folderId: "f1",
			attachmentsDeletedCount: 1,
		})
		expect(order).toEqual([
			"listFolderAttachmentRows f1",
			"bucket attachments/e1/a1/receipt.pdf",
			"deleteFolderRows f1",
		])
	})

	it("refuses a system Folder without deleting anything", async () => {
		const { env, order } = fakeDeleteEnv({ folder: { isDeletable: false, attachments: [] } })

		expect(await deleteFolderAndFiles(env, "me@example.com", "inbox")).toEqual({
			status: "folder_not_deletable",
		})
		expect(order).toEqual(["listFolderAttachmentRows inbox"])
	})

	it("reports a Folder that is not there", async () => {
		const { env } = fakeDeleteEnv({ folder: null })

		expect(await deleteFolderAndFiles(env, "me@example.com", "f1")).toEqual({
			status: "folder_not_found",
		})
	})

	it("keeps the Folder and its Messages when a bucket refuses the delete", async () => {
		const { env, order } = fakeDeleteEnv({
			folder: { isDeletable: true, attachments: [receipt] },
			refuseDelete: true,
		})

		expect(await deleteFolderAndFiles(env, "me@example.com", "f1")).toEqual({
			status: "attachment_delete_failed",
			folderId: "f1",
			remainingKeysCount: 1,
			error: attachmentDeleteErrorMessage("attachment_delete_failed"),
		})
		expect(order).toEqual(["listFolderAttachmentRows f1", "bucket attachments/e1/a1/receipt.pdf"])
	})
})
