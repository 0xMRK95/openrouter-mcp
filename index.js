#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// --- Constants ---
const CACHE_TTL = 60 * 60 * 1000;
const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAX_TOKENS = 4096;

const MODEL_ALIASES = {
  fast: "google/gemini-2.5-flash",
  cheap: "google/gemini-2.5-flash",
  smart: "google/gemini-2.5-pro",
  powerful: "google/gemini-2.5-pro",
  code: "deepseek/deepseek-chat",
  reason: "deepseek/deepseek-r1",
  thinking: "deepseek/deepseek-r1",
  creative: "mistral/mistral-large-latest",
};

// --- State ---
let defaultModel = process.env.OPENROUTER_MODEL || null;
const modelsCache = { data: [], timestamp: 0 };
const threads = new Map();
const personas = new Map();
const usage = { limit: null, spent: 0, calls: 0 };

// --- Helpers ---

function getApiKey() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error(
      "OPENROUTER_API_KEY not set. Add it when registering:\n" +
        "claude mcp add openrouter -e OPENROUTER_API_KEY=sk-or-... node /path/to/index.js"
    );
  }
  return key;
}

function resolveModel(input) {
  if (!input) return null;
  return MODEL_ALIASES[input.toLowerCase()] || input;
}

function estimateCost(modelId, tokens) {
  const m = modelsCache.data.find((x) => x.id === modelId);
  if (!m?.pricing) return null;
  const p = tokens.prompt_tokens * parseFloat(m.pricing.prompt || "0");
  const c = tokens.completion_tokens * parseFloat(m.pricing.completion || "0");
  return p + c;
}

async function callOpenRouter(model, messages, { temperature, max_tokens } = {}) {
  const apiKey = getApiKey();

  if (usage.limit !== null && usage.spent >= usage.limit) {
    throw new Error(
      `Session budget of $${usage.limit.toFixed(2)} reached (spent: $${usage.spent.toFixed(4)}). Use set_budget to adjust.`
    );
  }

  const body = { model, messages, max_tokens: max_tokens ?? DEFAULT_MAX_TOKENS };
  if (temperature !== undefined) body.temperature = temperature;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

  let res;
  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/openrouter-mcp",
        "X-Title": "openrouter-mcp",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Request to ${model} timed out after ${DEFAULT_TIMEOUT / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) {
    throw new Error("Rate limited by OpenRouter. Try again in a moment.");
  }

  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try {
      msg = JSON.parse(text).error?.message || text;
    } catch {}
    throw new Error(`OpenRouter error (${res.status}): ${msg}`);
  }

  const data = await res.json();

  if (!data.choices?.[0]?.message?.content) {
    throw new Error(`Unexpected response from OpenRouter: ${JSON.stringify(data)}`);
  }

  const tokens = data.usage || {};
  const result = {
    text: data.choices[0].message.content,
    tokens: {
      prompt_tokens: tokens.prompt_tokens || 0,
      completion_tokens: tokens.completion_tokens || 0,
    },
    model: data.model || model,
  };

  result.cost = estimateCost(result.model, result.tokens);
  if (result.cost !== null) usage.spent += result.cost;
  usage.calls++;

  return result;
}

async function fetchModels() {
  if (modelsCache.data.length > 0 && Date.now() - modelsCache.timestamp < CACHE_TTL) {
    return modelsCache.data;
  }

  const apiKey = getApiKey();
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) throw new Error(`Failed to fetch models: ${res.status}`);

  const data = await res.json();
  modelsCache.data = (data.data || [])
    .map((m) => ({
      id: m.id,
      name: m.name,
      context_length: m.context_length,
      pricing: m.pricing,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  modelsCache.timestamp = Date.now();
  return modelsCache.data;
}

function findClosestModel(id, models) {
  const lower = id.toLowerCase();
  const matches = models.filter(
    (m) =>
      m.id.toLowerCase().includes(lower) ||
      (m.name && m.name.toLowerCase().includes(lower))
  );
  if (matches.length === 0) return null;
  return matches.find((m) => m.id.toLowerCase().startsWith(lower)) || matches[0];
}

function formatPrice(price) {
  if (!price) return "?";
  const val = parseFloat(price);
  if (val === 0) return "free";
  return `$${(val * 1_000_000).toFixed(2)}/M`;
}

function formatResult(result) {
  const t = `${result.tokens.prompt_tokens} in / ${result.tokens.completion_tokens} out`;
  const c = result.cost !== null ? ` · $${result.cost.toFixed(4)}` : "";
  return `**${result.model}** (${t}${c}):\n\n${result.text}`;
}

// --- Server ---

const server = new McpServer({
  name: "openrouter-mcp",
  version: "2.0.0",
});

// ==================== chat ====================
server.tool(
  "chat",
  "Ask another AI model (DeepSeek, GPT, Gemini, Llama, Mistral, Qwen, and 500+ others) a question via OpenRouter. Use when the user says 'ask deepseek', 'ask gpt', 'ask gemini', or wants a second opinion, code review, or answer from a different model. Supports model aliases: fast, cheap, smart, code, reason, creative. Supports named conversation threads and saved personas.",
  {
    prompt: z.string().describe("The message to send"),
    model: z
      .string()
      .optional()
      .describe(
        "Model ID or alias (fast/cheap/smart/code/reason/creative). Uses persona model or session default if omitted"
      ),
    system: z
      .string()
      .optional()
      .describe("System prompt. Overrides persona system prompt if both provided"),
    persona: z
      .string()
      .optional()
      .describe("Use a saved persona by name (sets system prompt and optionally model)"),
    thread_id: z
      .string()
      .optional()
      .describe(
        "Continue a named conversation thread. The external model sees the full thread history for multi-turn dialogue"
      ),
    temperature: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe("0 = deterministic, 1 = creative"),
    max_tokens: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(`Max response tokens (default: ${DEFAULT_MAX_TOKENS})`),
  },
  async ({ prompt, model, system, persona, thread_id, temperature, max_tokens }) => {
    // Resolve persona
    let systemPrompt = system;
    let personaModel = null;
    if (persona) {
      const p = personas.get(persona);
      if (!p) {
        return {
          content: [
            {
              type: "text",
              text: `Persona "${persona}" not found. Use list_personas to see available personas.`,
            },
          ],
          isError: true,
        };
      }
      if (!systemPrompt) systemPrompt = p.system;
      personaModel = p.model;
    }

    // Resolve model: explicit > persona > default
    const resolvedModel =
      resolveModel(model) || resolveModel(personaModel) || resolveModel(defaultModel);
    if (!resolvedModel) {
      return {
        content: [
          {
            type: "text",
            text: "No model specified and no default set. Use set_model to set a default, or pass the model parameter.",
          },
        ],
        isError: true,
      };
    }

    // Build messages array
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    if (thread_id && threads.has(thread_id)) {
      messages.push(...threads.get(thread_id));
    }
    messages.push({ role: "user", content: prompt });

    try {
      const result = await callOpenRouter(resolvedModel, messages, {
        temperature,
        max_tokens,
      });

      // Update thread history
      if (thread_id) {
        if (!threads.has(thread_id)) threads.set(thread_id, []);
        const thread = threads.get(thread_id);
        thread.push({ role: "user", content: prompt });
        thread.push({ role: "assistant", content: result.text });
      }

      const threadNote = thread_id
        ? `\n\n_thread: ${thread_id} (${(threads.get(thread_id)?.length || 0) / 2} turns)_`
        : "";
      return { content: [{ type: "text", text: formatResult(result) + threadNote }] };
    } catch (err) {
      return { content: [{ type: "text", text: err.message }], isError: true };
    }
  }
);

// ==================== set_model ====================
server.tool(
  "set_model",
  "Set the default model for OpenRouter queries. Accepts model IDs or aliases (fast/cheap/smart/code/reason/creative).",
  {
    name: z
      .string()
      .describe("Model ID or alias to set as default (e.g. deepseek/deepseek-r1, fast, code)"),
  },
  async ({ name }) => {
    const resolved = resolveModel(name);
    const wasAlias = resolved !== name ? ` (alias for **${resolved}**)` : "";

    try {
      const models = await fetchModels();
      const exact = models.find((m) => m.id === resolved);
      if (!exact) {
        const closest = findClosestModel(resolved, models);
        if (closest) {
          defaultModel = closest.id;
          return {
            content: [
              {
                type: "text",
                text: `"${name}"${wasAlias} not found. Did you mean **${closest.id}**? Set as default.`,
              },
            ],
          };
        }
        defaultModel = resolved;
        return {
          content: [
            {
              type: "text",
              text: `Default set to **${resolved}**${wasAlias} (not in cached model list — may still work).`,
            },
          ],
        };
      }
    } catch {}

    defaultModel = resolved;
    return {
      content: [{ type: "text", text: `Default model set to **${resolved}**${wasAlias}` }],
    };
  }
);

// ==================== list_models ====================
server.tool(
  "list_models",
  "List or search available AI models on OpenRouter (DeepSeek, GPT, Gemini, Llama, Mistral, etc). Filter by provider, price, or context length.",
  {
    search: z
      .string()
      .optional()
      .describe("Filter by name or ID (e.g. 'deepseek', 'gpt-4', 'llama')"),
    provider: z
      .string()
      .optional()
      .describe("Filter by provider prefix (e.g. 'google', 'meta', 'deepseek', 'openai')"),
    sort_by: z
      .enum(["name", "cost", "context"])
      .optional()
      .describe("Sort: name (default A-Z), cost (cheapest first), context (largest first)"),
    free: z.boolean().optional().describe("Only show free models"),
  },
  async ({ search, provider, sort_by, free }) => {
    try {
      let models = await fetchModels();

      if (search) {
        const q = search.toLowerCase();
        models = models.filter(
          (m) =>
            m.id.toLowerCase().includes(q) ||
            (m.name && m.name.toLowerCase().includes(q))
        );
      }
      if (provider) {
        const p = provider.toLowerCase().replace(/\/$/, "");
        models = models.filter((m) => m.id.toLowerCase().startsWith(p + "/"));
      }
      if (free) {
        models = models.filter((m) => {
          const pp = parseFloat(m.pricing?.prompt || "1");
          const cp = parseFloat(m.pricing?.completion || "1");
          return pp === 0 && cp === 0;
        });
      }

      if (sort_by === "cost") {
        models.sort(
          (a, b) =>
            parseFloat(a.pricing?.prompt || "999") -
            parseFloat(b.pricing?.prompt || "999")
        );
      } else if (sort_by === "context") {
        models.sort((a, b) => (b.context_length || 0) - (a.context_length || 0));
      }

      const hasFilter = search || provider || free;
      if (!hasFilter) models = models.slice(0, 50);

      if (models.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No models found matching your filters. Try a broader search.",
            },
          ],
        };
      }

      const lines = models.map((m) => {
        const pi = formatPrice(m.pricing?.prompt);
        const po = formatPrice(m.pricing?.completion);
        const ctx = m.context_length
          ? ` ctx:${(m.context_length / 1000).toFixed(0)}k`
          : "";
        return `- **${m.id}** — ${m.name || "unnamed"} (in:${pi} out:${po}${ctx})`;
      });

      const parts = [];
      const count = hasFilter
        ? `Found ${models.length} model(s):`
        : `Showing ${models.length} of ${modelsCache.data.length} models:`;
      parts.push(count);
      if (defaultModel) parts.push(`Default: **${defaultModel}**`);
      parts.push("Aliases: fast, cheap, smart, code, reason, creative");

      return {
        content: [{ type: "text", text: `${parts.join("\n")}\n\n${lines.join("\n")}` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: err.message }], isError: true };
    }
  }
);

// ==================== save_persona ====================
server.tool(
  "save_persona",
  "Save a reusable persona (system prompt + optional default model) for use with chat. Example: save as 'code_reviewer' with a detailed review prompt.",
  {
    name: z.string().describe("Persona name (e.g. 'code_reviewer', 'translator', 'rust_expert')"),
    system: z.string().describe("System prompt defining the persona's role and behavior"),
    model: z
      .string()
      .optional()
      .describe("Default model for this persona. Accepts aliases (fast/code/etc)"),
  },
  async ({ name, system, model }) => {
    const resolved = model ? resolveModel(model) : undefined;
    personas.set(name, { system, model: resolved });
    const modelNote = resolved ? ` with model **${resolved}**` : "";
    return {
      content: [
        {
          type: "text",
          text: `Persona **${name}** saved${modelNote}.\n\nUse with: \`chat(prompt="...", persona="${name}")\``,
        },
      ],
    };
  }
);

// ==================== list_personas ====================
server.tool(
  "list_personas",
  "Show all saved personas available for use with chat.",
  {},
  async () => {
    if (personas.size === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No personas saved yet. Use save_persona to create one.",
          },
        ],
      };
    }
    const lines = [];
    for (const [name, p] of personas) {
      const model = p.model ? ` (model: ${p.model})` : "";
      const preview =
        p.system.length > 80 ? p.system.slice(0, 80) + "..." : p.system;
      lines.push(`- **${name}**${model}: ${preview}`);
    }
    return {
      content: [{ type: "text", text: `Saved personas:\n\n${lines.join("\n")}` }],
    };
  }
);

// ==================== set_budget ====================
server.tool(
  "set_budget",
  "Set a session spending limit for OpenRouter API calls. Prevents runaway costs. Set to 0 to remove the limit.",
  {
    limit: z
      .number()
      .min(0)
      .describe("Max spend in USD for this session. 0 = no limit"),
  },
  async ({ limit }) => {
    if (limit === 0) {
      usage.limit = null;
      return {
        content: [
          {
            type: "text",
            text: `Budget limit removed. Current spend: $${usage.spent.toFixed(4)} across ${usage.calls} calls.`,
          },
        ],
      };
    }
    usage.limit = limit;
    const remaining = Math.max(0, limit - usage.spent);
    return {
      content: [
        {
          type: "text",
          text: `Budget set to **$${limit.toFixed(2)}**. Spent: $${usage.spent.toFixed(4)} (${usage.calls} calls). Remaining: $${remaining.toFixed(4)}.`,
        },
      ],
    };
  }
);

// ==================== get_usage ====================
server.tool(
  "get_usage",
  "Show OpenRouter API spending and call count for this session.",
  {},
  async () => {
    const limitStr =
      usage.limit !== null ? `$${usage.limit.toFixed(2)}` : "none";
    const remaining =
      usage.limit !== null
        ? `$${Math.max(0, usage.limit - usage.spent).toFixed(4)}`
        : "unlimited";
    return {
      content: [
        {
          type: "text",
          text: `**Session usage:**\n- Calls: ${usage.calls}\n- Spent: $${usage.spent.toFixed(4)}\n- Budget: ${limitStr}\n- Remaining: ${remaining}`,
        },
      ],
    };
  }
);

// ==================== show_thread ====================
server.tool(
  "show_thread",
  "Show the conversation history of a named thread. Threads are created by passing thread_id to chat.",
  {
    thread_id: z.string().describe("The thread name to display"),
  },
  async ({ thread_id }) => {
    const thread = threads.get(thread_id);
    if (!thread || thread.length === 0) {
      return {
        content: [
          { type: "text", text: `Thread "${thread_id}" not found or empty.` },
        ],
      };
    }
    const lines = thread.map((m) => {
      const role = m.role === "user" ? "**You:**" : "**Model:**";
      return `${role}\n${m.content}`;
    });
    return {
      content: [
        {
          type: "text",
          text: `**Thread: ${thread_id}** (${thread.length / 2} turns)\n\n${lines.join("\n\n---\n\n")}`,
        },
      ],
    };
  }
);

// ==================== clear_thread ====================
server.tool(
  "clear_thread",
  "Delete a conversation thread to free memory or start over.",
  {
    thread_id: z.string().describe("The thread name to delete"),
  },
  async ({ thread_id }) => {
    if (!threads.has(thread_id)) {
      return {
        content: [{ type: "text", text: `Thread "${thread_id}" not found.` }],
      };
    }
    const turns = (threads.get(thread_id).length || 0) / 2;
    threads.delete(thread_id);
    return {
      content: [
        {
          type: "text",
          text: `Thread "${thread_id}" cleared (was ${turns} turns).`,
        },
      ],
    };
  }
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("openrouter-mcp v2.0.0 started");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
