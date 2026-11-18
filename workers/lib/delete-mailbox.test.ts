import { describe, expect, it } from "bun:test"
import { attachmentDeleteErrorMessage } from "./attachments"
import { deleteMailboxAndFiles } from "./delete"
import { type AttachmentRow, fakeDeleteEnv, note, receipt } from "./delete-fakes"

describe("deleting a Mailbox", () => {
	it("removes its Attachment objects, its store, its chat, then its listing object", async () => {
		const { env, order } = fakeDeleteEnv({ mailboxRows: [receipt, note] })

		expect(await deleteMailboxAndFiles(env, "me@example.com")).toEqual({
			status: "deleted",
			mailboxId: "me@example.com",
			attachmentsDeletedCount: 2,
		})
		expect(order).toEqual([
			"listMailboxAttachmentRows",
			"bucket attachments/e1/a1/receipt.pdf,attachments/e1/a2/note.txt",
			"deleteMailboxStore",
			"agent /deleteMailboxState",
			"bucket mailboxes/me@example.com.json",
		])
	})

	it("keeps two Messages that share a filename apart", async () => {
		const shared: AttachmentRow = { id: "a7", email_id: "e7", filename: "receipt.pdf" }
		const { env, removed } = fakeDeleteEnv({ mailboxRows: [receipt, shared] })

		await deleteMailboxAndFiles(env, "me@example.com")

		expect(removed).toEqual([
			"attachments/e1/a1/receipt.pdf",
			"attachments/e7/a7/receipt.pdf",
			"mailboxes/me@example.com.json",
		])
	})

	it("still wipes the store and the chat when the Mailbox has no Attachments", async () => {
		const { env, order } = fakeDeleteEnv({ mailboxRows: [] })

		expect(await deleteMailboxAndFiles(env, "me@example.com")).toEqual({
			status: "deleted",
			mailboxId: "me@example.com",
			attachmentsDeletedCount: 0,
		})
		expect(order).toEqual([
			"listMailboxAttachmentRows",
			"deleteMailboxStore",
			"agent /deleteMailboxState",
			"bucket mailboxes/me@example.com.json",
		])
	})

	it("leaves the Mailbox listed when a bucket refuses the delete", async () => {
		const { env, order } = fakeDeleteEnv({ mailboxRows: [receipt, note], refuseDelete: true })

		expect(await deleteMailboxAndFiles(env, "me@example.com")).toEqual({
			status: "attachment_delete_failed",
			mailboxId: "me@example.com",
			remainingKeysCount: 2,
			error: attachmentDeleteErrorMessage("attachment_delete_failed"),
		})
		expect(order).toEqual([
			"listMailboxAttachmentRows",
			"bucket attachments/e1/a1/receipt.pdf,attachments/e1/a2/note.txt",
		])
	})

	it("keeps the Mailbox listed when the agent cannot clear its chat", async () => {
		const { env, order } = fakeDeleteEnv({ mailboxRows: [], refuseChatClear: true })

		expect(await deleteMailboxAndFiles(env, "me@example.com")).toEqual({
			status: "chat_clear_failed",
			mailboxId: "me@example.com",
			error: "The Mailbox chat could not be cleared (500), so the Mailbox was not deleted",
		})
		expect(order).toEqual([
			"listMailboxAttachmentRows",
			"deleteMailboxStore",
			"agent /deleteMailboxState",
		])
	})
})
