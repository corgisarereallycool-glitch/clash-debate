// AI provider for the judge and the AI opponent.
//
// Picks the first one that is configured:
//   ANTHROPIC_API_KEY  -> Claude (paid)
//   GEMINI_API_KEY     -> Google Gemini (free key from aistudio.google.com, no card)
//   otherwise          -> Pollinations (free, no key, no signup)
// Set AI_PROVIDER=off to use only the built-in offline scoring and stock speeches.
//
// Pollinations' keyless tier allows one request at a time per server, about
// 30 seconds apart. So on that tier every call waits its turn in one queue,
// the judge always gets a slot, and the AI opponent falls back to stock lines
// whenever a slot isn't free right away.

const env = process.env;
const choice = (env.AI_PROVIDER || "").toLowerCase();
export const PROVIDER =
  choice === "off" ? "off" :
  choice || (env.ANTHROPIC_API_KEY ? "anthropic" : env.GEMINI_API_KEY ? "gemini" : "pollinations");

const ANTHROPIC_MODELS = { judge: env.JUDGE_MODEL || "claude-sonnet-5-5", bot: env.BOT_MODEL || "claude-haiku-5-5" };
const GEMINI_MODEL = env.GEMINI_MODEL || "gemini-2.5-flash";
const POLL_URL = env.POLLINATIONS_URL || "https://text.pollinations.ai/";
const POLL_TOKEN = env.POLLINATIONS_TOKEN || ""; // optional, removes the 30s limit
const GAP_MS = Number(env.AI_MIN_GAP_MS ?? (PROVIDER === "pollinations" && !POLL_TOKEN ? 31000 : 0));

export const AI = { on: PROVIDER !== "off", provider: PROVIDER, label: {
  anthropic: "Claude", gemini: "Gemini (free tier)", pollinations: "Pollinations (free, no key)", off: "offline estimate" }[PROVIDER] || PROVIDER };

/* ---------- one-at-a-time queue with spacing ---------- */
let nextFree = 0;          // time the next request may start
let tail = Promise.resolve();
function slotWait() { return Math.max(0, nextFree - Date.now()); }
function inQueue(fn) {
  const run = tail.then(async () => {
    const w = slotWait(); if (w) await new Promise((r) => setTimeout(r, w));
    try { return await fn(); } finally { nextFree = Date.now() + GAP_MS; }
  });
  tail = run.catch(() => {});
  return run;
}
let busy = 0;

/**
 * ai(prompt, { role: "judge" | "bot" | "chat", maxTokens })
 * Resolves with the reply text. Rejects when no slot is free (bot/chat only) or on failure.
 */
export async function ai(prompt, { role = "judge", maxTokens = 600 } = {}) {
  if (!AI.on) throw new Error("AI is off");
  if (GAP_MS && role !== "judge" && (busy > 0 || slotWait() > 1500)) throw new Error("no free AI slot");
  busy++;
  try { return await (GAP_MS ? inQueue(() => call(prompt, role, maxTokens)) : call(prompt, role, maxTokens)); }
  finally { busy--; }
}

async function call(prompt, role, maxTokens) {
  const timeout = AbortSignal.timeout(role === "judge" ? 120000 : 25000);
  if (PROVIDER === "anthropic") {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: timeout,
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: role === "judge" ? ANTHROPIC_MODELS.judge : ANTHROPIC_MODELS.bot, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  }
  if (PROVIDER === "gemini") {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST", signal: timeout,
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: Math.max(maxTokens, role === "judge" ? 4000 : 800), temperature: role === "judge" ? 0.3 : 0.9 } }),
    });
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
  }
  // Pollinations: POST / with chat messages, plain-text answer.
  const headers = { "content-type": "application/json" };
  if (POLL_TOKEN) headers.authorization = `Bearer ${POLL_TOKEN}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(POLL_URL, { method: "POST", signal: timeout, headers,
      body: JSON.stringify({ messages: [{ role: "user", content: prompt }], private: true, temperature: role === "judge" ? 0.3 : 0.9 }) });
    if (r.ok) {
      const t = (await r.text()).trim();
      if (t) return t;
      throw new Error("Pollinations returned an empty answer");
    }
    if ((r.status === 402 || r.status === 429) && attempt === 0 && role === "judge") {
      const wait = Math.min(60, Number(r.headers.get("retry-after")) || 31) * 1000;
      await new Promise((res) => setTimeout(res, wait));
      continue;
    }
    throw new Error(`Pollinations ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  throw new Error("Pollinations is busy");
}
