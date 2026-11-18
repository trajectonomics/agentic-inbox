// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Fakes for the outgoing-send tests. Kept out of the `*.test.ts` file so that
 * file stays within the repository's 200-line ceiling; nothing here is used
 * by production code.
 */
import type { Env } from "../types"
import { type OutgoingRecorder, type OutgoingThreading, sendAndRecord } from "./outgoing-send"
import type { OutgoingMessage } from "./schemas"

export const MAILBOX = "me@example.com"

/** An Email binding that accepts every message and reports `messageId`. */
export function acceptingBinding(messageId: string | undefined) {
	const sent: unknown[] = []
	const binding = {
		send: async (message: unknown) => {
			sent.push(message)
			return { messageId }
		},
	}
	return { binding: binding as unknown as Env["EMAIL"], sends: () => sent.length }
}

/** An Email binding that refuses every message with `reason`. */
export function refusingBinding(reason: string) {
	let sends = 0
	const binding = {
		send: async () => {
			sends += 1
			throw new Error(reason)
		},
	}
	return { binding: binding as unknown as Env["EMAIL"], sends: () => sends }
}

/** An R2 bucket that records the keys it is asked to write. */
export function fakeBucket() {
	const keys: string[] = []
	const bucket = {
		put: async (key: string) => {
			keys.push(key)
		},
	}
	return { bucket: bucket as unknown as Env["BUCKET"], keys }
}

/** A mailbox recorder that records every call, and can fail while recording. */
export function fakeRecorder(options: { rateLimit?: string; failsToRecord?: boolean } = {}) {
	const recorded: { folder: string; message: OutgoingMessage; attachments: unknown[] }[] = []
	const marks: string[] = []
	const recorder: OutgoingRecorder = {
		checkSendRateLimit: async () => options.rateLimit ?? null,
		createEmail: async (folder, message, attachments) => {
			if (options.failsToRecord) throw new Error("storage unavailable")
			recorded.push({ folder, message, attachments })
		},
		markThreadRead: async (threadId) => {
			marks.push(threadId)
		},
	}
	return { recorder, recorded, marks }
}

/** One send over fresh fakes, so each case reads as its outcome. */
export function harness(
	options: {
		messageId?: string
		from?: string
		mailboxId?: string
		refuse?: string
		rateLimit?: string
		failsToRecord?: boolean
	} = {},
) {
	const mail = options.refuse
		? refusingBinding(options.refuse)
		: acceptingBinding(options.messageId)
	const bucket = fakeBucket()
	const { recorder, recorded, marks } = fakeRecorder(options)
	const body = {
		to: "Them@Example.ORG",
		from: options.from ?? MAILBOX,
		subject: "Hello",
		html: "<p>hi</p>",
		attachments: [
			{
				content: "aGVsbG8=",
				filename: "note.txt",
				type: "text/plain",
				disposition: "attachment" as const,
			},
		],
	}
	return {
		keys: bucket.keys,
		recorded,
		marks,
		sends: mail.sends,
		result: (threading: OutgoingThreading = {}) =>
			sendAndRecord({ EMAIL: mail.binding, BUCKET: bucket.bucket }, recorder, {
				mailboxId: options.mailboxId ?? MAILBOX,
				body,
				threading,
			}),
	}
}

/** A named header entry of a recorded Message. */
export function storedHeader(message: OutgoingMessage, key: string): string | undefined {
	const headers: { key: string; value: string }[] = JSON.parse(message.raw_headers)
	return headers.find((header) => header.key === key)?.value
}
