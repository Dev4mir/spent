---
status: superseded by ADR-0003
---

# The product pays for AI; it does not run on the user's Claude/Codex subscription

The product targets people who already pay for Claude or Codex, but the AI work behind voice logging is billed to the product, roughly $0.001–0.005 per Expense. Running on the user's own plan was the goal and was ruled out. Anthropic forbids third-party apps from using Pro/Max credentials. OpenAI's "Sign in with ChatGPT" is waitlist-only for hosted apps. Claude artifact apps, which do run on the viewer's plan, disable Claude and connector calls for anyone outside the author's organization, and Claude's voice mode has no Arabic.

## Considered Options

- **Use extracted Claude/Codex login tokens.** Rejected: against provider terms, and it puts users' accounts at risk.
- **A claude.ai artifact app using `sample` and `mcp`.** Rejected: unusable by the public, no mobile connectors, no microphone.
- **A remote MCP connector inside the Claude app.** Deferred: no Arabic voice. It could be added later as a second entry point on the same backend.
- **Bring your own API key.** Deferred: only Max and Ultra plans include API credits, and Claude's API cannot transcribe audio.

Revisit if Anthropic or OpenAI open a sanctioned "bill the user's plan" program for hosted apps.
