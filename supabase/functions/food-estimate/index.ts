// Food estimate for The System's Food tab: a description and/or one photo in, calories and protein per item out.
// Deployed with --no-verify-jwt because it checks the caller's Supabase session itself, so only a signed-in user
// of this project (sign-ups are off, so just the owner) can spend the Anthropic key kept in the function's secrets.
// Secrets: ANTHROPIC_API_KEY (required), FOOD_MODEL (optional, default claude-opus-5-5), SYSTEM_OWNER (optional user id).
import Anthropic from "npm:@anthropic-ai/sdk@0.135.0";

const MODEL = Deno.env.get("FOOD_MODEL") || "claude-opus-5-5";
const ORIGINS = ["https://charliequance.github.io", "http://localhost:8766", "http://127.0.0.1:8766", "http://localhost:8770", "http://127.0.0.1:8770"];

const SYSTEM = `You estimate calories and protein for a food log.
Read the description and/or the photo and list each distinct food or drink once, with the portion you assumed in its name, like "Chicken wrap, 1 large".
When a brand or restaurant is named or visible, use its published nutrition (the Canadian version where it differs). Otherwise assume a typical portion for one adult.
Round calories to the nearest 10 kcal and protein to the nearest gram.
In note, give one short sentence on what you assumed or what would change the estimate most. If nothing in the input is food, return no items and say so in note.`;

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, cal: { type: "integer" }, pro: { type: "integer" } },
        required: ["name", "cal", "pro"],
        additionalProperties: false,
      },
    },
    note: { type: "string" },
  },
  required: ["items", "note"],
  additionalProperties: false,
};

const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY"), timeout: 90_000, maxRetries: 1 });

function cors(req: Request): Record<string, string> {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const reply = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

// The caller needs a live session for this project, and must be SYSTEM_OWNER when that secret is set.
async function signedIn(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization") || "";
  const key = req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (!auth.startsWith("Bearer ")) return false;
  const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, { headers: { Authorization: auth, apikey: key } });
  if (!r.ok) return false;
  const owner = Deno.env.get("SYSTEM_OWNER");
  return !owner || (await r.json())?.id === owner;
}

type Item = { name: string; cal: number; pro: number };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return reply(req, 405, { error: "Use POST." });
  if (!(await signedIn(req))) return reply(req, 401, { error: "Sign in to the System first." });

  let body: { text?: unknown; image?: unknown };
  try { body = await req.json(); } catch { return reply(req, 400, { error: "Send JSON." }); }
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 2000) : "";
  const image = typeof body.image === "string" ? body.image : "";
  if (!text && !image) return reply(req, 400, { error: "Describe the food or add a photo." });
  if (image.length > 6_000_000) return reply(req, 413, { error: "That photo is too big." });

  try {
    const msg = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{
        role: "user",
        content: [
          ...(image ? [{ type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: image } }] : []),
          { type: "text" as const, text: text ? `What I ate: ${text}` : "What I ate is in the photo." },
        ],
      }],
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      // A declined request reruns on Anthropic's recommended fallback model. Haiku has no server-side fallback.
      ...(MODEL.startsWith("claude-haiku") ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
    });
    if (msg.stop_reason === "refusal") return reply(req, 200, { items: [], note: "Claude couldn't estimate that one. Type the numbers in instead." });
    const out = msg.content.find((b) => b.type === "text");
    const parsed = JSON.parse(out && out.type === "text" ? out.text : "{}");
    const items: Item[] = (Array.isArray(parsed.items) ? parsed.items : [])
      .filter((x: Item) => x && typeof x.name === "string")
      .map((x: Item) => ({ name: x.name.slice(0, 120), cal: Math.max(0, Math.round(Number(x.cal) || 0)), pro: Math.max(0, Math.round(Number(x.pro) || 0)) }));
    return reply(req, 200, {
      items,
      note: typeof parsed.note === "string" ? parsed.note : "",
      model: msg.model,
      usage: { input: msg.usage.input_tokens, output: msg.usage.output_tokens },
    });
  } catch (e) {
    if (e instanceof SyntaxError) return reply(req, 502, { error: "Claude's answer didn't come back as a list. Try again." });
    if (e instanceof Anthropic.AuthenticationError) return reply(req, 502, { error: "The Anthropic API key is missing or wrong." });
    if (e instanceof Anthropic.RateLimitError) return reply(req, 503, { error: "Claude is busy. Try again in a minute." });
    if (e instanceof Anthropic.APIConnectionError) return reply(req, 504, { error: "Couldn't reach Claude. Try again." });
    if (e instanceof Anthropic.APIError) {
      return reply(req, 502, { error: e.status === 402 ? "Your Claude API credit ran out. Top it up in the Claude Console." : `Claude error ${e.status ?? ""}`.trim() });
    }
    return reply(req, 500, { error: "Something went wrong. Try again." });
  }
});
