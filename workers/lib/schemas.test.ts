import { describe, expect, it } from "bun:test"
import { ErrorResponseSchema, SendEmailRequestSchema, SendEmailResponseSchema } from "./schemas"

describe("schemas", () => {
	it("validates valid SendEmailRequest with text body", () => {
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

	it("rejects SendEmailRequest missing both html and text", () => {
		const payload = {
			to: "test@example.com",
			from: "sender@example.com",
			subject: "Missing Body",
		}
		expect(() => SendEmailRequestSchema.parse(payload)).toThrow(
			"Either 'html' or 'text' must be provided",
		)
	})

	it("rejects SendEmailRequest with invalid recipient email", () => {
		const payload = {
			to: "not-an-email",
			from: "sender@example.com",
			subject: "Test",
			text: "Body",
		}
		expect(() => SendEmailRequestSchema.parse(payload)).toThrow()
	})

	it("validates ErrorResponseSchema and SendEmailResponseSchema", () => {
		const errorObj = ErrorResponseSchema.parse({ error: "Something went wrong" })
		expect(errorObj.error).toBe("Something went wrong")

		const sendObj = SendEmailResponseSchema.parse({ id: "msg-123", status: "sent" })
		expect(sendObj.id).toBe("msg-123")
		expect(sendObj.status).toBe("sent")
	})
})
