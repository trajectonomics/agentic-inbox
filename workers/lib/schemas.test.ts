import { describe, expect, it } from "bun:test"
import { ErrorResponseSchema, SendEmailRequestSchema, SendEmailResponseSchema } from "./schemas"

describe("email schemas", () => {
	it("accepts valid outbound email with plain text body", () => {
		const payload = {
			to: "test@example.com",
			from: "sender@example.com",
			subject: "Hello World",
			text: "This is a plain text body",
		}
		const parsed = SendEmailRequestSchema.parse(payload)
		expect(parsed.to).toBe("test@example.com")
		expect(parsed.subject).toBe("Hello World")
	})

	it("accepts valid outbound email with attachments", () => {
		const payload = {
			to: "test@example.com",
			from: "sender@example.com",
			subject: "Invoice",
			text: "Please find attached invoice.",
			attachments: [
				{
					content: "aGVsbG8=",
					filename: "invoice.pdf",
					type: "application/pdf",
					disposition: "attachment" as const,
				},
			],
		}
		const parsed = SendEmailRequestSchema.parse(payload)
		expect(parsed.attachments?.length).toBe(1)
		expect(parsed.attachments?.[0]?.filename).toBe("invoice.pdf")
	})

	it("rejects dispatch when both HTML and plaintext bodies are omitted", () => {
		const payload = {
			to: "test@example.com",
			from: "sender@example.com",
			subject: "Missing Body",
		}
		expect(() => SendEmailRequestSchema.parse(payload)).toThrow(
			"Either 'html' or 'text' must be provided",
		)
	})

	it("rejects email sending when recipient address is malformed", () => {
		const payload = {
			to: "not-an-email",
			from: "sender@example.com",
			subject: "Test",
			text: "Body",
		}
		expect(() => SendEmailRequestSchema.parse(payload)).toThrow("Invalid email")
	})

	it("validates API error response payload structure", () => {
		const errorObj = ErrorResponseSchema.parse({ error: "Something went wrong" })
		expect(errorObj.error).toBe("Something went wrong")
	})

	it("validates successful email transmission response structure", () => {
		const sendObj = SendEmailResponseSchema.parse({ id: "msg-123", status: "sent" })
		expect(sendObj.id).toBe("msg-123")
		expect(sendObj.status).toBe("sent")
	})
})
