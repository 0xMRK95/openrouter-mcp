# 🌐 openrouter-mcp

**Talk to 500+ AI models from inside Claude Code.** One file. Zero config. Just works.

> _"ask deepseek to review this code"_ — and it does. Without leaving your session.

---

## 🤯 Why This Exists

You're in Claude Code. You're deep in a problem. You want a second opinion from DeepSeek. Or a quick answer from Gemini. Or you want to see how GPT handles a prompt.

**Before:** Open a new tab. Copy context. Paste. Wait. Copy response. Paste back. Lose your flow.

**After:**

```
❯ ask deepseek to review my auth implementation

  deepseek/deepseek-r1 (142 in / 891 out · $0.0028):

  "Three issues: 1) The JWT expiry is set to 30 days which is too long..."
```

That's it. One sentence. The model responds inline. You never leave your session.

---

## ⚡ 30-Second Setup

```bash
# 1. Get an API key from https://openrouter.ai/keys

# 2. Add to Claude Code
claude mcp add openrouter -s user \
  -e OPENROUTER_API_KEY=sk-or-... \
  -- npx openrouter-mcp

# 3. Restart Claude Code. Done.
```

Or install from source:

```bash
git clone https://github.com/anthropics/openrouter-mcp
cd openrouter-mcp && npm install

claude mcp add openrouter -s user \
  -e OPENROUTER_API_KEY=sk-or-... \
  -- node /path/to/openrouter-mcp/index.js
```

---

## 🎯 What You Can Do

### 💬 Ask any model anything

```
❯ ask deepseek to explain this regex
❯ ask gemini to find bugs in my code
❯ ask gpt what design pattern fits here
```

Just say "ask [model]" and Claude routes it through OpenRouter. Token usage and cost shown on every response.

### 🏷️ Use aliases instead of memorizing model IDs

```
❯ ask the fast model to summarize this file
❯ ask the code model to optimize this function
❯ ask the reason model why this algorithm is O(n²)
```

| Alias | Model | Best for |
|-------|-------|----------|
| `fast` | gemini-2.5-flash | Quick answers, summaries |
| `cheap` | gemini-2.5-flash | Budget-friendly queries |
| `smart` | gemini-2.5-pro | Complex analysis |
| `powerful` | gemini-2.5-pro | Deep reasoning tasks |
| `code` | deepseek-chat | Code gen, debugging |
| `reason` | deepseek-r1 | Step-by-step logic |
| `thinking` | deepseek-r1 | Chain-of-thought problems |
| `creative` | mistral-large | Writing, brainstorming |

### 🧵 Have multi-turn conversations with external models

```
❯ start a thread called "refactor" with deepseek — here's my database module [code]

  deepseek: "I see several issues with the connection pooling..."

❯ continue the refactor thread — what about the query builder?

  deepseek: "Building on what we discussed, the query builder should..."
```

The external model remembers the full conversation. Your Claude session stays clean. Delegate complex sub-tasks to a specialist model without polluting your main context.

### 🎭 Save personas for instant role-switching

```
❯ save a persona called "security_auditor" — expert at finding vulnerabilities, uses deepseek

❯ use the security_auditor persona to review my auth middleware

  deepseek (as security_auditor): "Critical: the token validation
  doesn't check for algorithm confusion attacks..."
```

Save a system prompt + model combo once, reuse it by name forever (within the session). Perfect for:
- `code_reviewer` — thorough, opinionated reviews
- `translator` — technical docs in any language
- `explain_like_5` — simplify complex concepts
- `devil_advocate` — challenge your assumptions

### 💰 Track spending and set budgets

```
❯ set openrouter budget to $2

  Budget set to $2.00. Remaining: $2.0000.

❯ how much have I spent on openrouter?

  Session usage:
  - Calls: 12
  - Spent: $0.0847
  - Budget: $2.00
  - Remaining: $1.9153
```

Every response already shows inline cost: `(142 in / 891 out · $0.0028)`. Set a hard budget limit and the server blocks requests when you hit it. No surprise bills.

### 🔍 Find the right model

```
❯ search openrouter models for deepseek
❯ show me free models on openrouter
❯ list google models sorted by cost
❯ what openrouter models have the largest context?
```

Filter by provider, search by name, sort by cost or context length. 500+ models at your fingertips.

---

## 🛠️ All 9 Tools

| Tool | What it does |
|------|-------------|
| `chat` | Send a prompt to any model. Supports aliases, personas, threads |
| `set_model` | Set session default model |
| `list_models` | Browse/search models with filters (provider, cost, context, free) |
| `save_persona` | Save a system prompt + model combo |
| `list_personas` | Show saved personas |
| `set_budget` | Set session spending limit |
| `get_usage` | Show calls, spend, remaining budget |
| `show_thread` | Display a thread's conversation history |
| `clear_thread` | Delete a thread |

---

## 🏗️ Architecture

```
Claude Code session
  │
  │  You: "ask deepseek to review this code"
  │
  ├─ Claude sees your full conversation
  │  Composes a prompt with relevant context
  │
  ├─ MCP tool call → openrouter-mcp (stdio)
  │    │
  │    ├─ Resolves model alias/persona/default
  │    ├─ Loads thread history if applicable
  │    ├─ Checks budget limit
  │    ├─ POST openrouter.ai/api/v1/chat/completions
  │    ├─ Tracks token usage + cost
  │    └─ Returns response with metadata
  │
  └─ Claude presents the response to you
```

**Key design decisions:**

- **Stateless relay** — Claude handles context. The MCP server just forwards. No complex state management.
- **Threads are opt-in** — Only when you explicitly name a thread does the server maintain state.
- **Budget is session-scoped** — Resets on restart. No persistent config to manage.
- **Single file** — The entire server is `index.js`. Read it in 5 minutes.

---

## ⚙️ Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | ✅ | Your OpenRouter API key |
| `OPENROUTER_MODEL` | ❌ | Initial default model (can also use `set_model`) |

That's it. No config files.

---

## 📊 What You See on Every Response

```
deepseek/deepseek-r1 (142 in / 891 out · $0.0028):

The actual response text here...
```

- **Model name** — which model actually responded
- **Token count** — prompt tokens in / completion tokens out
- **Cost** — estimated cost based on OpenRouter pricing
- **Thread info** — turn count if using a thread

---

## 🧩 Works With

- ✅ **Claude Code** (primary target)
- ✅ Any MCP-compatible client
- ✅ Node.js 18+
- ✅ macOS, Linux, Windows (WSL)

---

## 📦 One File

The entire server is [`index.js`](./index.js) — 617 lines, 2 dependencies, zero build step. Read it, fork it, extend it.

```
openrouter-mcp/
├── index.js         ← the entire server
├── package.json
└── README.md
```

---

## 🤝 Contributing

PRs welcome. The bar is simple: does it make the tool more useful without making it more complex?

Good PRs:
- New model aliases as the landscape evolves
- Better cost estimation
- Smarter typo correction

Please don't:
- Add config files
- Add a build step
- Break the single-file design

---

## 📄 License

MIT
