// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared types and Zod schemas for email data.
 *
 * Types (from email-types.ts): used by the agent, MCP server, and route
 * handlers to avoid `as any` casting.
 *
 * Zod schemas: used across route handlers to eliminate duplication.
 */
import { z } from "zod"

// ── TypeScript Interfaces ──────────────────────────────────────────

export interface EmailMetadata {
	id: string
	subject: string
	sender: string
	recipient: string
	cc?: string | null
	bcc?: string | null
	date: string
	read: boolean
	starred: boolean
	in_reply_to?: string | null
	email_references?: string | null
	thread_id?: string | null
	folder_id?: string | null
	snippet?: string | null
}

export interface EmailFull extends EmailMetadata {
	body?: string | null
	message_id?: string | null
	raw_headers?: string | null
	attachments?: AttachmentInfo[]
}

export interface AttachmentInfo {
	id: string
	filename: string
	mimetype: string
	size: number
	content_id?: string | null
	disposition?: string | null
}

// ── Zod Schemas ────────────────────────────────────────────────────

const RecipientFieldSchema = z.union([z.string().email(), z.array(z.string().email()).min(1)])

export const ErrorResponseSchema = z.object({
	error: z.string(),
})

export const SendEmailRequestSchema = z
	.object({
		to: RecipientFieldSchema,
		cc: RecipientFieldSchema.optional(),
		bcc: RecipientFieldSchema.optional(),
		from: z.union([z.string().email(), z.object({ email: z.string().email(), name: z.string() })]),
		subject: z.string(),
		html: z.string().optional(),
		text: z.string().optional(),
		attachments: z
			.array(
				z.object({
					content: z.string(), // base64 encoded
					filename: z.string(),
					type: z.string(),
					disposition: z.enum(["attachment", "inline"]),
					contentId: z.string().optional(),
				}),
			)
			.optional(),
		in_reply_to: z.string().optional(),
		references: z.array(z.string()).optional(),
		thread_id: z.string().optional(),
	})
	.refine((data) => data.html || data.text, {
		message: "Either 'html' or 'text' must be provided",
	})

/** An outgoing message as a browser send route receives it, after validation. */
export type SendEmailRequest = z.infer<typeof SendEmailRequestSchema>

/**
 * The Message an accepted send records in the `sent` folder, validated as it
 * crosses from the Worker into the mailbox Durable Object.
 */
export const OutgoingMessageSchema = z.object({
	id: z.string(),
	subject: z.string(),
	sender: z.string(),
	recipient: z.string(),
	cc: z.string().nullable(),
	bcc: z.string().nullable(),
	date: z.string(),
	body: z.string(),
	in_reply_to: z.string().nullable(),
	email_references: z.string().nullable(),
	thread_id: z.string(),
	message_id: z.string(),
	raw_headers: z.string(),
})

/** The stored shape of an accepted outgoing Message. */
export type OutgoingMessage = z.infer<typeof OutgoingMessageSchema>

export const SendEmailResponseSchema = z.object({
	id: z.string(),
	status: z.string(),
})

/**
 * One Attachment row as a delete reads it: the ids and the filename that name
 * its R2 object and nothing else. Validated at the Worker/Durable Object
 * boundary so a delete never builds a key from a shape it did not expect.
 */
export const AttachmentKeyRowSchema = z.object({
	id: z.string(),
	email_id: z.string(),
	filename: z.string(),
})

/** The Attachment rows a Message, Mailbox or Folder delete reads. */
export const AttachmentKeyRowsSchema = z.array(AttachmentKeyRowSchema)

/**
 * The Folder row a delete reads: the `is_deletable` rule that decides whether
 * the Folder may go, and the Attachment rows of the Messages inside it.
 */
export const FolderDeletionRowsSchema = z.object({
	isDeletable: z.boolean(),
	attachments: AttachmentKeyRowsSchema,
})

/**
 * The filters `list_attachments` accepts, validated before they reach the
 * mailbox Durable Object. `limit` and `offset` are integers, because SQLite
 * rejects a fractional LIMIT.
 */
export const ListAttachmentsFiltersSchema = z.object({
	emailId: z.string().min(1).optional().describe("Only files on this email id"),
	mimetype: z.string().min(1).optional().describe("Only this MIME type, e.g. application/pdf"),
	sender: z.string().min(1).optional().describe("Only files from this sender address"),
	since: z.string().min(1).optional().describe("Only mail dated on or after this date (ISO 8601)"),
	until: z.string().min(1).optional().describe("Only mail dated on or before this date (ISO 8601)"),
	includeInline: z.boolean().optional().describe("Include inline parts such as signature logos"),
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe("Maximum files to return, 1 to 100; default 25"),
	offset: z.number().int().min(0).optional().describe("Files to skip, for pagination"),
})
