# GLOSSARY.md

Domain language for `trajectonomics/agentic-inbox`. Terms here are canonical; do not introduce synonyms in code, comments, or documentation.

## Core Concepts

### Mailbox
A logical email inbox identified by an email address (e.g. `user@example.com`). In the backend, every mailbox maps to a dedicated Cloudflare Durable Object (`MailboxDO`) containing its own private SQLite database.

### Thread
A grouped collection of related email messages sharing a common `thread_id` and connected by RFC 5322 `In-Reply-To` and `References` headers.

### Message (Email)
An individual email message. Contains metadata (sender, recipient, subject, date, read status, starred status), plain text and HTML body content, and optional attachment references.

### Folder
A organizational container for messages within a mailbox. Canonical system folders include `inbox`, `sent`, `draft`, `archive`, `trash`, and `spam`. Custom folders are user-defined.

### Attachment
Binary file content associated with an email. Stored in Cloudflare R2 object storage (`BUCKET`), with metadata (id, filename, MIME type, size) stored in the mailbox SQLite database.

## System & Infrastructure

### MailboxDO
A Cloudflare Durable Object managing SQLite tables (via Drizzle ORM) for emails, threads, folders, and attachments for a specific mailbox.

### EmailAgent
A Cloudflare Durable Object that runs autonomous AI workflows, tools, and evaluations for an inbox.

### EmailMCP
A Cloudflare Durable Object implementing the Model Context Protocol (MCP) server endpoints, enabling external AI agents to list, read, search, draft, and send emails securely.

### Email Routing
The Cloudflare Email Routing service that receives inbound emails destined for configured domains and forwards them to the worker script for processing.

### Workers AI
Cloudflare's serverless AI inference service used for detecting prompt injection in inbound emails and verifying/refining email drafts.
