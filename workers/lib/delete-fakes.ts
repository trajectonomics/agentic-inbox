// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Test doubles for `workers/lib/delete.ts`.
 *
 * Only the delete tests import this module, so the Worker bundle never carries
 * it. The Mailbox Durable Object, the EmailAgent and the R2 bucket each record
 * the call they receive into one ordered list, which is how a test reads the
 * delete's sequence.
 */
import type { Env } from "../types"
import type { AttachmentKeyRow } from "./attachments"

/** An Attachment row of the Message `e1`. */
export const receipt: AttachmentKeyRow = { id: "a1", email_id: "e1", filename: "receipt.pdf" }

/** A second Attachment row of the Message `e1`. */
export const note: AttachmentKeyRow = { id: "a2", email_id: "e1", filename: "note.txt" }

/** What a test lets the fake environment answer, and refuse. */
export interface FakeDeleteEnvOptions {
	attachmentRows?: Record<string, AttachmentKeyRow[] | null>
	mailboxRows?: AttachmentKeyRow[]
	folder?: { isDeletable: boolean; attachments: AttachmentKeyRow[] } | null
	refuseDelete?: boolean
	refuseChatClear?: boolean
}

/**
 * A fake Worker environment for one delete: the Mailbox stub answers the rows
 * the test gives it, the bucket removes keys or refuses, and every call lands
 * in `order`.
 */
export function fakeDeleteEnv(options: FakeDeleteEnvOptions) {
	const order: string[] = []
	const removed: string[] = []
	const step = (name: string) => {
		order.push(name)
	}

	const mailbox = {
		listAttachmentRows: async (emailId: string) => {
			step(`listAttachmentRows ${emailId}`)
			return options.attachmentRows?.[emailId] ?? null
		},
		deleteEmailRows: async (emailId: string) => step(`deleteEmailRows ${emailId}`),
		listMailboxAttachmentRows: async () => {
			step("listMailboxAttachmentRows")
			return options.mailboxRows ?? []
		},
		deleteMailboxStore: async () => step("deleteMailboxStore"),
		listFolderAttachmentRows: async (folderId: string) => {
			step(`listFolderAttachmentRows ${folderId}`)
			return options.folder ?? null
		},
		deleteFolderRows: async (folderId: string) => step(`deleteFolderRows ${folderId}`),
	}

	const agent = {
		fetch: async (request: Request) => {
			step(`agent ${new URL(request.url).pathname}`)
			return new Response("{}", { status: options.refuseChatClear ? 500 : 200 })
		},
	}

	const bucket = {
		delete: async (keys: string | string[]) => {
			const list = Array.isArray(keys) ? keys : [keys]
			step(`bucket ${list.join(",")}`)
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
