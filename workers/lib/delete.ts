// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Delete rules for Messages, Mailboxes and Folders.
 *
 * Every caller that deletes goes through this module, so no caller has to
 * remember a second step: one that reports success has removed the bytes too.
 *
 * Order: the Attachment objects go first, the records last. The rows are the
 * record of which R2 keys exist, so a failure part-way leaves a state a retry
 * can finish. A delete that cannot remove the Attachment objects reports
 * `attachment_delete_failed` and leaves every record in place.
 *
 * The Durable Object stays a store of records: it lists the rows a delete
 * needs and removes rows, and R2 belongs to `workers/lib/attachments.ts`.
 */
import type { Env } from "../types"
import {
	attachmentDeleteErrorMessage,
	attachmentObjectKeys,
	deleteAttachmentObjects,
} from "./attachments"
import { getMailboxStub } from "./email-helpers"
import { AttachmentKeyRowsSchema, FolderDeletionRowsSchema } from "./schemas"

/** What removing the Attachment objects of a delete did. One code per rule. */
type AttachmentRemoval =
	| { status: "removed"; deletedCount: number }
	| { status: "attachment_delete_failed"; remainingKeysCount: number; error: string }

/** What deleting a Message did. One code per rule. */
export type DeleteEmailResult =
	| { status: "deleted"; emailId: string; attachmentsDeletedCount: number }
	| {
			status: "attachment_delete_failed"
			emailId: string
			remainingKeysCount: number
			error: string
	  }
	| { status: "email_not_found" }

/** What deleting a Mailbox did. A Mailbox always exists once its route calls this. */
export type DeleteMailboxResult =
	| { status: "deleted"; mailboxId: string; attachmentsDeletedCount: number }
	| {
			status: "attachment_delete_failed"
			mailboxId: string
			remainingKeysCount: number
			error: string
	  }
	| { status: "chat_clear_failed"; mailboxId: string; error: string }

/** What deleting a custom Folder did. One code per rule. */
export type DeleteFolderResult =
	| { status: "deleted"; folderId: string; attachmentsDeletedCount: number }
	| {
			status: "attachment_delete_failed"
			folderId: string
			remainingKeysCount: number
			error: string
	  }
	| { status: "folder_not_found" }
	| { status: "folder_not_deletable" }

/**
 * Remove the Attachment objects of the rows a Durable Object returned, in
 * chunks of 1000, and report the refusal with the one sentence callers show.
 * Validates the rows at the Worker/Durable Object boundary first.
 */
async function removeAttachmentObjects(env: Env, rows: unknown): Promise<AttachmentRemoval> {
	const parsed = AttachmentKeyRowsSchema.parse(rows)
	const removed = await deleteAttachmentObjects(env.BUCKET, attachmentObjectKeys(parsed))

	if (removed.remainingKeys.length > 0) {
		return {
			status: "attachment_delete_failed",
			remainingKeysCount: removed.remainingKeys.length,
			error: attachmentDeleteErrorMessage("attachment_delete_failed"),
		}
	}

	return { status: "removed", deletedCount: removed.deletedKeys.length }
}

/**
 * Delete one Message and its Attachment objects. A Message that is not there
 * changes nothing; a bucket that refuses the delete leaves the rows in place
 * and names how many keys remain, so a retry can finish the job.
 */
export async function deleteEmailAndFiles(
	env: Env,
	mailboxId: string,
	emailId: string,
): Promise<DeleteEmailResult> {
	const stub = getMailboxStub(env, mailboxId)
	const listed = await stub.listAttachmentRows(emailId)
	if (listed === null) return { status: "email_not_found" }

	const removal = await removeAttachmentObjects(env, listed)
	if (removal.status === "attachment_delete_failed") return { ...removal, emailId }

	await stub.deleteEmailRows(emailId)

	return { status: "deleted", emailId, attachmentsDeletedCount: removal.deletedCount }
}

/**
 * Delete a Mailbox and everything under it: its Attachment objects, then its
 * SQLite store, then that Mailbox's EmailAgent chat, then its listing object.
 * The Mailbox stays listed until the end, so a delete that fails part-way can
 * be retried; every step is idempotent.
 *
 * `mailboxId` is the normalized address (decoded and lowercased), as the
 * Mailbox listing object and the EmailAgent are keyed by it.
 *
 * A chat that cannot be cleared is reported as `chat_clear_failed`: the
 * Attachment objects and the store are already gone by then, the listing object
 * is still there, and repeating the delete finishes it. A Durable Object that
 * throws while its store is removed surfaces as an ordinary error, and the
 * listing object is likewise still there.
 */
export async function deleteMailboxAndFiles(
	env: Env,
	mailboxId: string,
): Promise<DeleteMailboxResult> {
	const stub = getMailboxStub(env, mailboxId)
	const listed = await stub.listMailboxAttachmentRows()

	const removal = await removeAttachmentObjects(env, listed)
	if (removal.status === "attachment_delete_failed") return { ...removal, mailboxId }

	await stub.deleteMailboxStore()

	const agent = env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(mailboxId))
	const cleared = await agent.fetch(
		new Request("https://agents/deleteMailboxState", { method: "POST" }),
	)
	if (!cleared.ok) {
		return {
			status: "chat_clear_failed",
			mailboxId,
			error: `The Mailbox chat could not be cleared (${cleared.status}); its mail is already deleted, so deleting the Mailbox again finishes the job`,
		}
	}

	await env.BUCKET.delete(`mailboxes/${mailboxId}.json`)

	return { status: "deleted", mailboxId, attachmentsDeletedCount: removal.deletedCount }
}

/**
 * Delete a custom Folder and everything under it: the Attachment objects of
 * its Messages, then those Messages and their Attachment rows, then the Folder
 * row. A system Folder answers `folder_not_deletable` and an absent one
 * `folder_not_found`, so the two rules never share one answer.
 */
export async function deleteFolderAndFiles(
	env: Env,
	mailboxId: string,
	folderId: string,
): Promise<DeleteFolderResult> {
	const stub = getMailboxStub(env, mailboxId)
	const listed = await stub.listFolderAttachmentRows(folderId)
	if (listed === null) return { status: "folder_not_found" }

	const folder = FolderDeletionRowsSchema.parse(listed)
	if (!folder.isDeletable) return { status: "folder_not_deletable" }

	const removal = await removeAttachmentObjects(env, folder.attachments)
	if (removal.status === "attachment_delete_failed") return { ...removal, folderId }

	await stub.deleteFolderRows(folderId)

	return { status: "deleted", folderId, attachmentsDeletedCount: removal.deletedCount }
}
