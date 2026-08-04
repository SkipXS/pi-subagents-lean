# Fixed tool registration

The four public tools are registered once at extension init with minimal,
byte-stable parameter schemas and concise static descriptions. They have no
prompt snippets or guidelines, parameter descriptions, or runtime-generated
enums. The required `agent` field is always a bare `Type.String()`; it never
has a config- or registry-driven enum. Model and thinking are intentionally
absent from the LLM-visible `Agent` schema and remain controlled through Agent
Markdown and settings.

## Why

Calling `registerTool()` at runtime rebuilds tools and can invalidate the system-prompt/KV-cache prefix. A fixed schema prevents mid-session tool registration and cache churn.

When enabled, the parent-only orchestration block is the sole automatic catalog
of visible agents. It is regenerated from the trusted live registry before each
parent turn, independently of the tool schema. Disabling that block deliberately
provides no automatic catalog. Model and thinking use the shared precedence:
internal spawn value > session-agent > persistent agent > Agent Markdown >
global > parent. The internal spawn level is settings plumbing, not a public
tool override.

## Trade-off

The schema is intentionally terse, so the model learns parameter usage from names and tool results. This keeps recurring tokens minimal and leaves dynamic discovery out of the schema.
