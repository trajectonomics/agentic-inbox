import { describe, expect, it } from "bun:test"
import { attachmentDeleteErrorMessage } from "./attachments"
import { deleteEmailAndFiles } from "./delete"
import { fakeDeleteEnv, note, receipt } from "./delete-fakes"

describe("deleting a Message", () => {
	it("removes its Attachment objects before its rows", async () => {
		const { env, order } = fakeDeleteEnv({ attachmentRows: { e1: [receipt, note] } })

		expect(await deleteEmailAndFiles(env, "me@example.com", "e1")).toEqual({
			status: "deleted",
			emailId: "e1",
			attachmentsDeletedCount: 2,
		})
		expect(order).toEqual([
			"listAttachmentRows e1",
			"bucket attachments/e1/a1/receipt.pdf,attachments/e1/a2/note.txt",
			"deleteEmailRows e1",
		])
	})

	it("deletes a Message that has no Attachments without touching R2", async () => {
		const { env, order } = fakeDeleteEnv({ attachmentRows: { e1: [] } })

		expect(await deleteEmailAndFiles(env, "me@example.com", "e1")).toEqual({
			status: "deleted",
			emailId: "e1",
			attachmentsDeletedCount: 0,
		})
		expect(order).toEqual(["listAttachmentRows e1", "deleteEmailRows e1"])
	})

	it("reports a Message that is not there without deleting anything", async () => {
		const { env, order } = fakeDeleteEnv({ attachmentRows: { e1: null } })

		expect(await deleteEmailAndFiles(env, "me@example.com", "e1")).toEqual({
			status: "email_not_found",
		})
		expect(order).toEqual(["listAttachmentRows e1"])
	})

	it("leaves the rows in place when a bucket refuses the delete", async () => {
		const { env, order } = fakeDeleteEnv({
			attachmentRows: { e1: [receipt, note] },
			refuseDelete: true,
		})

		expect(await deleteEmailAndFiles(env, "me@example.com", "e1")).toEqual({
			status: "attachment_delete_failed",
			emailId: "e1",
			remainingKeysCount: 2,
			error: attachmentDeleteErrorMessage("attachment_delete_failed"),
		})
		expect(order).toEqual([
			"listAttachmentRows e1",
			"bucket attachments/e1/a1/receipt.pdf,attachments/e1/a2/note.txt",
		])
	})
})
