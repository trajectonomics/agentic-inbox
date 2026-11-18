import { describe, expect, it } from "bun:test"
import type { Env } from "../types"
import { attachmentDeleteErrorMessage } from "./attachments"
import { deleteEmailAndFiles, deleteFolderAndFiles, deleteMailboxAndFiles } from "./delete"

/** One Attachment row as the Mailbox Durable Object returns it. */
type Row = { id: string; email_id: string; filename: string }

const receipt: Row = { id: "a1", email_id: "e1", filename: "receipt.pdf" }
const note: Row = { id: "a2", email_id: "e1", filename: "note.txt" }

/**
 * A fake environment whose Mailbox Durable Object, EmailAgent and R2 bucket
 * record every call in order, so a test can read the delete's sequence.
 */
function fakeEnv(options: {
	attachmentRows?: Record<string, Row[] | null>
	mailboxRows?: Row[]
	folder?: { isDeletable: boolean; attachments: Row[] } | null
	refuseDelete?: boolean
}) {
	const order: string[] = []
	const removed: string[] = []

	const mailbox = {
		listAttachmentRows: async (emailId: string) => {
			order.push(`listAttachmentRows ${emailId}`)
			return options.attachmentRows?.[emailId] ?? null
		},
		deleteEmailRows: async (emailId: string) => {
			order.push(`deleteEmailRows ${emailId}`)
		},
		listMailboxAttachmentRows: async () => {
			order.push("listMailboxAttachmentRows")
			return options.mailboxRows ?? []
		},
		deleteMailboxStore: async () => {
			order.push("deleteMailboxStore")
		},
		listFolderAttachmentRows: async (folderId: string) => {
			order.push(`listFolderAttachmentRows ${folderId}`)
			return options.folder ?? null
		},
		deleteFolderRows: async (folderId: string) => {
			order.push(`deleteFolderRows ${folderId}`)
		},
	}

	const agent = {
		fetch: async (request: Request) => {
			order.push(`agent ${new URL(request.url).pathname}`)
			return new Response("{}")
		},
	}

	const bucket = {
		delete: async (keys: string | string[]) => {
			const list = Array.isArray(keys) ? keys : [keys]
			order.push(`bucket ${list.join(",")}`)
			if (options.refuseDelete) throw new Error("R2 refused")
			removed.push(...list)
		},
	}

	const env = {
		BUCKET: bucket,
		MAILBOX: { idFromName: (name: string) => name, get: () => mailbox },
		EMAIL_AGENT: { idFromName: (name: string) => name, get: () => agent },
	} as unknown as Env

	return { env, order, removed }
}

describe("deleting a Message", () => {
	it("removes its Attachment objects before its rows", async () => {
		const { env, order } = fakeEnv({ attachmentRows: { e1: [receipt, note] } })

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
		const { env, order } = fakeEnv({ attachmentRows: { e1: [] } })

		expect(await deleteEmailAndFiles(env, "me@example.com", "e1")).toEqual({
			status: "deleted",
			emailId: "e1",
			attachmentsDeletedCount: 0,
		})
		expect(order).toEqual(["listAttachmentRows e1", "deleteEmailRows e1"])
	})

	it("reports a Message that is not there without deleting anything", async () => {
		const { env, order } = fakeEnv({ attachmentRows: { e1: null } })

		expect(await deleteEmailAndFiles(env, "me@example.com", "e1")).toEqual({
			status: "email_not_found",
		})
		expect(order).toEqual(["listAttachmentRows e1"])
	})

	it("leaves the rows in place when a bucket refuses the delete", async () => {
		const { env, order } = fakeEnv({ attachmentRows: { e1: [receipt, note] }, refuseDelete: true })

		expect(await deleteEmailAndFiles(env, "me@example.com", "e1")).toEqual({
			status: "attachment_delete_failed",
			emailId: "e1",
			remainingKeys: 2,
			error: attachmentDeleteErrorMessage("attachment_delete_failed"),
		})
		expect(order).toEqual([
			"listAttachmentRows e1",
			"bucket attachments/e1/a1/receipt.pdf,attachments/e1/a2/note.txt",
		])
	})

	it("removes the bytes from the Message the Attachment row names, never the requested id", async () => {
		const other: Row = { id: "a9", email_id: "e9", filename: "bank.pdf" }
		const { env, removed } = fakeEnv({ attachmentRows: { e1: [other] } })

		await deleteEmailAndFiles(env, "me@example.com", "e1")

		expect(removed).toEqual(["attachments/e9/a9/bank.pdf"])
	})
})

describe("deleting a Mailbox", () => {
	it("removes its Attachment objects, its store, its chat, then its listing object", async () => {
		const { env, order } = fakeEnv({ mailboxRows: [receipt, note] })

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

	it("removes every object of the Mailbox and keeps two Messages with one filename apart", async () => {
		const shared: Row = { id: "a7", email_id: "e7", filename: "receipt.pdf" }
		const { env, removed } = fakeEnv({ mailboxRows: [receipt, shared] })

		await deleteMailboxAndFiles(env, "me@example.com")

		expect(removed).toEqual([
			"attachments/e1/a1/receipt.pdf",
			"attachments/e7/a7/receipt.pdf",
			"mailboxes/me@example.com.json",
		])
	})

	it("still wipes the store and the chat when the Mailbox has no Attachments", async () => {
		const { env, order } = fakeEnv({ mailboxRows: [] })

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
		const { env, order } = fakeEnv({ mailboxRows: [receipt, note], refuseDelete: true })

		expect(await deleteMailboxAndFiles(env, "me@example.com")).toEqual({
			status: "attachment_delete_failed",
			mailboxId: "me@example.com",
			remainingKeys: 2,
			error: attachmentDeleteErrorMessage("attachment_delete_failed"),
		})
		expect(order).toEqual([
			"listMailboxAttachmentRows",
			"bucket attachments/e1/a1/receipt.pdf,attachments/e1/a2/note.txt",
		])
	})
})

describe("deleting a Folder", () => {
	it("removes its Messages' Attachment objects before the Folder's rows", async () => {
		const { env, order } = fakeEnv({
			folder: { isDeletable: true, attachments: [receipt] },
		})

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
		const { env, order } = fakeEnv({ folder: { isDeletable: false, attachments: [] } })

		expect(await deleteFolderAndFiles(env, "me@example.com", "inbox")).toEqual({
			status: "folder_not_deletable",
		})
		expect(order).toEqual(["listFolderAttachmentRows inbox"])
	})

	it("reports a Folder that is not there", async () => {
		const { env } = fakeEnv({ folder: null })

		expect(await deleteFolderAndFiles(env, "me@example.com", "f1")).toEqual({
			status: "folder_not_found",
		})
	})

	it("keeps the Folder and its Messages when a bucket refuses the delete", async () => {
		const { env, order } = fakeEnv({
			folder: { isDeletable: true, attachments: [receipt] },
			refuseDelete: true,
		})

		expect(await deleteFolderAndFiles(env, "me@example.com", "f1")).toEqual({
			status: "attachment_delete_failed",
			folderId: "f1",
			remainingKeys: 1,
			error: attachmentDeleteErrorMessage("attachment_delete_failed"),
		})
		expect(order).toEqual(["listFolderAttachmentRows f1", "bucket attachments/e1/a1/receipt.pdf"])
	})
})
