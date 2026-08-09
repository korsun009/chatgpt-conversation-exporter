# Security Policy

## Supported version

Security fixes are applied to the latest release of ChatGPT Conversation Exporter.

## Reporting a vulnerability

Please use a private GitHub Security Advisory for vulnerabilities that could expose conversation data, session credentials, access tokens or downloaded files.

Do not post the following in a public Issue:

- ChatGPT access tokens or request authorization headers;
- private conversation URLs and owner identifiers;
- exported conversations, manifests or ZIP archives containing personal data;
- private File IDs, screenshots or unredacted browser logs.

For ordinary functional bugs, create a public Issue with a minimal reproduction and redacted diagnostics. State the exporter version, browser, acquisition mode (`structured` or `dom`) and HTTP status without including private content.

## Security boundaries

The exporter runs in the context of an authenticated `chatgpt.com` page. It can access only data allowed to the current browser session. It does not bypass ChatGPT permissions and cannot recover attachments rejected by the server with `HTTP 403`.
