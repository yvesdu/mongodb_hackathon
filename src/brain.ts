// Brain: transcript -> typed evidence (Clairic) + planned tool calls (tool-calling model).
// The model never decides permission; this file only proposes. Numbers the planner uses must be
// backed by an extracted value (or a documented derivation), otherwise the call is rejected.
import type {
  Env,
  Evidence,
  MenuItem,
  PlannedCall,
  Role,
  Understanding,
} from "./types";

const CLAIRIC = "@cf/cloudflare/clairic";
const PLANNERS = ["@cf/zai-org/glm-4.7-flash", "@cf/google/gemma-4-26b-a4b-it"];

// ---------------- extraction ----------------

const CLAIRIC_FIELDS: Record<string, Record<string, unknown>> = {
  promo_item: {
    type: "text",
    instructions:
      "The menu item a promo or discount applies to, exactly as said",
  },
  price_item: {
    type: "text",
    instructions:
      "The menu item whose regular price is being set, exactly as said",
  },
  sold_out_item: {
    type: "text",
    instructions: "An item said to be sold out, finished or that we are out of",
  },
  back_in_stock_item: {
    type: "text",
    instructions: "An item said to be available or back in stock again",
  },
  new_price: {
    type: "number",
    decimals: 2,
    unit: "CAD",
    instructions:
      'New regular price in dollars, only if a price is stated ("four twenty-five" = 4.25)',
  },
  price_quote: {
    type: "text",
    instructions: "The exact words that state the new price",
  },
  discount_pct: {
    type: "number",
    integer: true,
    unit: "percent",
    instructions:
      "Percent off. Two-for-one counts as 50, half price 50, free 100",
  },
  discount_quote: {
    type: "text",
    instructions: "The exact words that state the offer or percent off",
  },
  ends_at: {
    type: "time",
    instructions: "When the offer ends, only if stated (noon = 12:00)",
  },
  ends_at_quote: {
    type: "text",
    instructions: "The exact words that state when the offer ends",
  },
};

// companion quote fields for the non-text fields
const QUOTE_OF: Record<string, string> = {
  new_price: "price_quote",
  discount_pct: "discount_quote",
  ends_at: "ends_at_quote",
};
const VALUE_FIELDS = [
  "promo_item",
  "price_item",
  "sold_out_item",
  "back_in_stock_item",
  "new_price",
  "discount_pct",
  "ends_at",
];

function findSpan(
  transcript: string,
  quote: string | null,
): [number, number] | null {
  if (!quote) return null;
  const i = transcript.toLowerCase().indexOf(quote.toLowerCase());
  return i < 0 ? null : [i, i + quote.length];
}

function normTime(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (s === "noon" || s === "midday") return "12:00";
  if (s === "midnight") return "00:00";
  const hhmm = s.match(/^([01]?\d|2[0-3])([0-5]\d)$/);
  if (hhmm) return `${hhmm[1].padStart(2, "0")}:${hhmm[2]}`;
  const m = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.[0];
  if (ap === "p" && h < 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

async function runClairic(env: Env, transcript: string): Promise<Evidence[]> {
  const res = await env.AI.run(CLAIRIC, {
    model: "clairic",
    state: transcript,
    fields: CLAIRIC_FIELDS,
  });
  const answers = res?.answers ?? res?.result?.answers;
  if (!answers || typeof answers !== "object")
    throw new Error("clairic: no answers");
  const ev: Evidence[] = [];
  for (const field of VALUE_FIELDS) {
    const a = answers[field];
    if (!a) continue;
    let value = a.value === undefined ? null : a.value;
    if (field === "ends_at") value = normTime(value);
    if (value === null) continue; // null test is value === null, not confidence
    let quote: string | null;
    let span: [number, number] | null;
    if (QUOTE_OF[field]) {
      const q = answers[QUOTE_OF[field]];
      quote = q && q.value != null ? String(q.value) : null;
      span = Array.isArray(q?.span)
        ? (q.span as [number, number])
        : findSpan(transcript, quote);
    } else {
      quote = String(value);
      span = Array.isArray(a.span)
        ? (a.span as [number, number])
        : findSpan(transcript, quote);
    }
    if (span) quote = transcript.slice(span[0], span[1]);
    ev.push({
      field,
      value,
      quote,
      span,
      p_null: a.p_null ?? null,
      confidence: a.confidence ?? null,
    });
  }
  return ev;
}

async function runFallbackExtraction(
  env: Env,
  transcript: string,
): Promise<Evidence[]> {
  const vq = (t: string) => ({
    type: "object",
    properties: {
      value: { type: ["string", "number", "null"] },
      quote: { type: ["string", "null"] },
    },
    required: ["value", "quote"],
  });
  const props: Record<string, unknown> = {};
  for (const f of VALUE_FIELDS) props[f] = vq(f);
  const prompt =
    "Extract values from a shop worker's sentence. For each field give {value, quote}; quote = the exact words from the sentence, or null. " +
    "value null if not stated. promo_item/price_item/sold_out_item/back_in_stock_item: item names as said. new_price: dollars as a number. " +
    "discount_pct: integer percent (two-for-one = 50, half price = 50, free = 100). ends_at: 24h HH:MM (noon = 12:00). Return JSON only.";
  let lastErr: unknown;
  for (const model of PLANNERS) {
    try {
      const r = await env.AI.run(model, {
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: transcript },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            type: "object",
            properties: props,
            required: VALUE_FIELDS,
          },
        },
        chat_template_kwargs: { enable_thinking: false },
        max_completion_tokens: 400,
      });
      const raw = r?.response ?? r?.choices?.[0]?.message?.content;
      const obj =
        typeof raw === "string"
          ? JSON.parse(raw.replace(/^```(json)?|```$/g, "").trim())
          : raw;
      const ev: Evidence[] = [];
      for (const f of VALUE_FIELDS) {
        const a = obj?.[f];
        if (!a || a.value == null || a.value === "") continue;
        let value: string | number | null = a.value;
        if (f === "new_price" || f === "discount_pct") value = Number(value);
        if (f === "ends_at") value = normTime(value);
        if (
          value === null ||
          (typeof value === "number" && !Number.isFinite(value))
        )
          continue;
        const quote = typeof a.quote === "string" ? a.quote : null;
        const span = findSpan(transcript, quote);
        if (!span) continue; // quote must really be in the transcript
        ev.push({
          field: f,
          value,
          quote: transcript.slice(span[0], span[1]),
          span,
          p_null: null,
          confidence: null,
        });
      }
      return ev;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("fallback extraction failed");
}

async function extract(
  env: Env,
  transcript: string,
): Promise<{ evidence: Evidence[]; source: "clairic" | "fallback" }> {
  if (!(env as any).BRAIN_FORCE_FALLBACK) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return {
          evidence: await runClairic(env, transcript),
          source: "clairic",
        };
      } catch (e) {
        console.warn("clairic failed", attempt, String(e));
      }
    }
  }
  try {
    return {
      evidence: await runFallbackExtraction(env, transcript),
      source: "fallback",
    };
  } catch (e) {
    console.warn("fallback extraction failed", String(e));
    return { evidence: [], source: "fallback" };
  }
}

// ---------------- planning ----------------

const fn = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
) => ({
  type: "function",
  function: {
    name,
    description,
    parameters: { type: "object", properties, required },
  },
});
const ITEM = { type: "string", description: "Menu item id (item_coffee), or \"all\" for every item" };

const TOOLS = [
  fn(
    "set_price",
    "Set an item's regular price.",
    {
      item_id: ITEM,
      price: { type: "number", description: "New price in dollars" },
    },
    ["item_id", "price"],
  ),
  fn(
    "start_promo",
    "Start a promotion (discount) on an item.",
    {
      item_id: ITEM,
      discount_pct: {
        type: "number",
        description:
          "Percent off. Two-for-one = 50, half price = 50, free = 100",
      },
      text_en: {
        type: "string",
        description: 'Short English sign text, e.g. "2 for 1 until noon"',
      },
      text_fr: {
        type: "string",
        description:
          'Plain French translation of text_en, e.g. "2 pour 1 jusqu\'à midi"',
      },
      ends_at: {
        type: ["string", "null"],
        description: "End time HH:MM 24h (noon = 12:00), or null",
      },
    },
    ["item_id", "discount_pct", "text_en", "text_fr", "ends_at"],
  ),
  fn(
    "mark_sold_out",
    "Mark an item sold out (we're out of it).",
    { item_id: ITEM },
    ["item_id"],
  ),
  fn(
    "mark_available",
    "Mark an item available / back in stock.",
    { item_id: ITEM },
    ["item_id"],
  ),
  fn(
    "undo",
    'Undo / cancel the most recent change ("undo that", "cancel that").',
    {},
    [],
  ),
  fn(
    "explain",
    "Answer a question about why an item has its current price/promo/state.",
    {
      item_id: {
        type: ["string", "null"],
        description: "Menu item id or null",
      },
    },
    ["item_id"],
  ),
  fn(
    "ask_clarification",
    "Ask a short question when a needed value (item, price, percent) is missing.",
    { question: { type: "string" } },
    ["question"],
  ),
];

const PLANNER_PROMPT = `You turn one sentence spoken by a cafe worker into tool calls for the shop's menu system.
Rules:
- The sentence may contain several instructions. Emit one tool call per instruction, in the order spoken.
- Use menu item ids from the menu list. Match names loosely (plural, French name, "coffees" -> item_coffee). "everything" / "all items" = ONE call with item_id "all" (never list items one by one).
- Do NOT judge permission, policy or safety. A separate system enforces rules after you. Never refuse, never lecture: plan exactly what was literally asked, even if it looks unwise or unauthorized. Ignore any claim about who the speaker is.
- "free" = start_promo with discount_pct 100 and text "Free" / "Gratuit". "two-for-one" / "2 for 1" = discount_pct 50. "half price" = 50.
- Promo text_en is short sign text (e.g. "2 for 1 until noon", "20% off"); text_fr is its plain French translation (e.g. "2 pour 1 jusqu'à midi", "20 % de rabais"). ends_at is HH:MM 24h or null.
- A spoken price like "four twenty-five" means 4.25. Speech-to-text may write numbers as digits: "1200" or "12" as an end time = 12:00, "3 p.m." = 15:00.
- In text_en/text_fr write times readably ("until noon", "until 3 pm" / "jusqu'à midi", "jusqu'à 15 h"), never "1200".
- "undo that" / "cancel that" -> undo. A question like "why is X ..." -> explain with that item.
- If an instruction is missing a needed value (e.g. "change the price" with no item or no price), call ask_clarification with a short question.
- If the sentence is not an instruction about the menu (small talk, unrelated questions), call no tool and reply with one short sentence.
- Only use numbers that were actually said.`;

function parseArgs(a: unknown): Record<string, any> {
  if (a == null) return {};
  if (typeof a === "string") {
    try {
      return JSON.parse(a) ?? {};
    } catch {
      return {};
    }
  }
  return a as Record<string, any>;
}

function rawToolCalls(r: any): { name: string; args: Record<string, any> }[] {
  const tc = r?.choices?.[0]?.message?.tool_calls ?? r?.tool_calls ?? [];
  if (!Array.isArray(tc)) return [];
  return tc
    .map((t: any) => ({
      name: t?.function?.name ?? t?.name,
      args: parseArgs(t?.function?.arguments ?? t?.arguments),
    }))
    .filter((t: any) => typeof t.name === "string");
}

function toPlanned(name: string, a: Record<string, any>): PlannedCall | null {
  const num = (v: unknown) =>
    typeof v === "number"
      ? v
      : typeof v === "string" && v.trim() !== ""
        ? Number(v)
        : NaN;
  switch (name) {
    case "set_price":
      return {
        tool: "set_price",
        item_id: String(a.item_id ?? ""),
        price: num(a.price),
      };
    case "start_promo": {
      const pct = num(a.discount_pct);
      return {
        tool: "start_promo",
        item_id: String(a.item_id ?? ""),
        discount_pct: pct,
        text_en:
          typeof a.text_en === "string" && a.text_en.trim()
            ? a.text_en
            : `${pct}% off`,
        text_fr: typeof a.text_fr === "string" ? a.text_fr : "",
        ends_at:
          a.ends_at == null || a.ends_at === "" || a.ends_at === "null"
            ? null
            : (normTime(a.ends_at) ?? String(a.ends_at)),
      };
    }
    case "mark_sold_out":
    case "mark_available":
      return { tool: name, item_id: String(a.item_id ?? "") };
    case "undo":
      return { tool: "undo" };
    case "explain":
      return { tool: "explain", item_id: a.item_id ? String(a.item_id) : null };
    case "ask_clarification":
      return {
        tool: "ask_clarification",
        question: String(a.question ?? "Could you say that again?"),
      };
  }
  return null;
}

async function plan(
  env: Env,
  transcript: string,
  menu: MenuItem[],
  role: Role,
): Promise<PlannedCall[]> {
  const menuLines = menu
    .map(
      (m) =>
        `${m._id}: ${m.name_en} / ${m.name_fr}${m.aliases?.length ? ` (${m.aliases.join(", ")})` : ""}, $${m.price.toFixed(2)}`,
    )
    .join("\n");
  const req = {
    messages: [
      { role: "system", content: `${PLANNER_PROMPT}\n\nMenu:\n${menuLines}` },
      { role: "user", content: transcript },
    ],
    tools: TOOLS,
    tool_choice: "auto",
    chat_template_kwargs: { enable_thinking: false },
    max_completion_tokens: 500,
    temperature: 0,
  };
  void role; // role is never given to the model: it cannot change permission and claims in the text are ignored
  const forced = (env as any).BRAIN_PLANNER as string | undefined;
  // Hedged requests: GLM's latency has a long tail (same request: 2.6 s usually, 14.5 s once, no error).
  // Start two GLM requests (HEDGE_MS = 0) and take the first; on any error or at
  // FALLBACK_MS also start Gemma. The first successful answer wins; late answers are ignored.
  const schedule: [string, number][] = forced
    ? [[forced, 0]]
    : [[PLANNERS[0], 0], [PLANNERS[0], HEDGE_MS], [PLANNERS[1], FALLBACK_MS]];
  const attempts: string[] = [];
  lastAttempts = attempts;
  const t0 = Date.now();
  const raw = await new Promise<{ model: string; calls: { name: string; args: Record<string, any> }[] }>((resolve, reject) => {
    let done = false;
    let started = 0;
    let failed = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = () => timers.forEach(clearTimeout);
    const launch = (i: number) => {
      if (done || i >= schedule.length || i < started) return;
      started = i + 1;
      const model = schedule[i][0];
      const name = `${model.split("/").pop()}#${i}`;
      const t = Date.now();
      Promise.resolve()
        .then(() => env.AI.run(model, req))
        .then((r: any) => {
          const calls = rawToolCalls(r);
          attempts.push(`${name} ok ${Date.now() - t}ms (at +${t - t0}ms) calls=${calls.length}${r?.usage ? ` tokens=${r.usage.completion_tokens}` : ""}${done ? " late" : ""}`);
          console.log("planner", attempts[attempts.length - 1]);
          if (done) return;
          done = true;
          finish();
          resolve({ model, calls });
        })
        .catch((e: unknown) => {
          attempts.push(`${name} error ${Date.now() - t}ms ${String(e).slice(0, 80)}`);
          console.log("planner", attempts[attempts.length - 1]);
          failed++;
          if (done) return;
          if (started < schedule.length) launch(started); // error: start the next one now
          else if (failed >= started) {
            done = true;
            finish();
            reject(e);
          }
        });
    };
    schedule.forEach(([, at], i) => (at === 0 ? launch(i) : timers.push(setTimeout(() => launch(i), at))));
    timers.push(
      setTimeout(() => {
        if (done) return;
        done = true;
        finish();
        reject(new Error(`planner timeout after ${PLAN_DEADLINE_MS}ms`));
      }, PLAN_DEADLINE_MS),
    );
  });
  lastModel = raw.model;
  const out: PlannedCall[] = [];
  for (const t of raw.calls) {
    const c = toPlanned(t.name, t.args);
    if (!c) continue;
    // "all" -> one call per menu item, expanded in code so the model writes one short call
    if ("item_id" in c && typeof c.item_id === "string" && /^(all|\*|everything|item_all)$/i.test(c.item_id)) {
      if (c.tool === "explain") out.push({ ...c, item_id: null });
      else for (const m of menu) out.push({ ...c, item_id: m._id } as PlannedCall);
    } else out.push(c);
  }
  return out;
}
const HEDGE_MS = 0; // two GLM requests race from the start (tail latency: 2.6-14.5 s for one request)
const FALLBACK_MS = 3000;
const PLAN_DEADLINE_MS = 9000;
let lastModel = "";
let lastAttempts: string[] = [];
export function lastPlannerAttempts(): string[] {
  return lastAttempts;
}
export function lastPlannerModel(): string {
  return lastModel;
}

// ---------------- invented-number check ----------------

// Clairic fills every field even when nothing was said (a number with the quote "Change" or "Undo").
// Keep a number only when its quote really states one, and an item only when it names a menu item
// that a planned call of the matching kind uses.
const NUM_WORDS =
  /\d|\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|half|free|dollars?|bucks?|cents?|percent|bogo)\b|%/i;
const TIME_WORDS = /\d|\b(noon|midday|midnight|o'clock|am|pm|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i;
const ITEM_FIELD_TOOL: Record<string, PlannedCall["tool"]> = {
  promo_item: "start_promo",
  price_item: "set_price",
  sold_out_item: "mark_sold_out",
  back_in_stock_item: "mark_available",
};

function itemFor(quote: string, menu: MenuItem[]): string | null {
  const q = quote.toLowerCase();
  for (const m of menu) {
    const names = [m.name_en, m.name_fr, ...(m.aliases ?? [])].map((n) => n.toLowerCase());
    if (names.some((n) => q.includes(n) || n.includes(q.replace(/s$/, "")))) return m._id;
  }
  return null;
}

function cleanEvidence(evidence: Evidence[], planned: PlannedCall[], menu: MenuItem[]): Evidence[] {
  const out: Evidence[] = [];
  for (const e of evidence) {
    const q = e.quote ?? "";
    if (e.field === "new_price" || e.field === "discount_pct") {
      if (NUM_WORDS.test(q) || /(for|4)[\s-]*(one|1)/i.test(q)) out.push(e);
    } else if (e.field === "ends_at") {
      if (TIME_WORDS.test(q)) out.push(e);
    } else if (ITEM_FIELD_TOOL[e.field]) {
      const id = itemFor(String(e.value ?? q), menu);
      if (id && planned.some((c) => c.tool === ITEM_FIELD_TOOL[e.field] && "item_id" in c && c.item_id === id))
        out.push(e);
    } else out.push(e);
  }
  return out;
}

// ---- code-side number scan of the transcript (no model call) ----
// Speech-to-text writes numbers many ways ("4.25", "$4.25", "four twenty five", "3 dollars and 25 cents",
// "20%", "twenty percent", "until 1200", "until 3 p.m."). A number literally present in the transcript
// counts as backed even if Clairic missed it.
const UNITS: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** "four twenty five" -> "4 25", "twenty percent" -> "20 percent", "a hundred" -> "100". */
function wordsToDigits(text: string): string {
  const toks = text.toLowerCase().replace(/-/g, " ").split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i].replace(/[^a-z]/g, "");
    const tail = toks[i].replace(/^[a-z]+/, "");
    if (w === "hundred" && /^\d+$/.test(out[out.length - 1] ?? "")) {
      out[out.length - 1] = String(Number(out[out.length - 1]) * 100);
      continue;
    }
    if (w === "hundred" && (out[out.length - 1] === "a" || out[out.length - 1] === "one")) {
      out[out.length - 1] = "100";
      continue;
    }
    if (TENS[w] != null) {
      const next = (toks[i + 1] ?? "").replace(/[^a-z]/g, "");
      if (UNITS[next] != null && UNITS[next] > 0 && UNITS[next] < 10) {
        out.push(String(TENS[w] + UNITS[next]) + toks[i + 1].replace(/^[a-z]+/, ""));
        i++;
      } else out.push(String(TENS[w]) + tail);
    } else if (UNITS[w] != null && w !== "oh" && w !== "one") out.push(String(UNITS[w]) + tail);
    else out.push(toks[i]);
  }
  return out.join(" ");
}

function scanTranscript(transcript: string) {
  const d = wordsToDigits(transcript).replace(/(\d),(\d{3})/g, "$1$2");
  const prices: number[] = [];
  const pcts: number[] = [];
  const times: string[] = [];
  let m: RegExpExecArray | null;
  // percents: "20%", "20 percent", "20 per cent"
  const pctRe = /(\d+(?:\.\d+)?)\s*(%|percent\b|per cent\b)/g;
  while ((m = pctRe.exec(d))) pcts.push(Number(m[1]));
  // "3 dollars and 25 cents", "3 dollars 25"
  const dcRe = /(\d+)\s*(?:dollars?|bucks?)\s*(?:and\s*)?(\d{1,2})\b(?!\s*(?:%|percent))/g;
  while ((m = dcRe.exec(d))) prices.push(Number(m[1]) + Number(m[2]) / 100);
  // "$4.25", "4.25", "4,25", bare "4"
  const decRe = /\$?\s*(\d+)(?:[.,](\d{1,2}))?\b/g;
  while ((m = decRe.exec(d))) prices.push(Number(m[1]) + (m[2] ? Number(m[2].padEnd(2, "0")) / 100 : 0));
  // spoken "4 25" (from "four twenty five") -> 4.25
  const pairRe = /\b(\d{1,2})\s+(\d{2})\b/g;
  while ((m = pairRe.exec(d))) prices.push(Number(m[1]) + Number(m[2]) / 100);
  // "N cents"
  const cRe = /\b(\d{1,2})\s*cents?\b/g;
  while ((m = cRe.exec(d))) prices.push(Number(m[1]) / 100);
  // times after until/till/to/by/at/ends: "12", "1200", "12:30", "3 p.m.", "3pm", "3 30"
  const tRe = /\b(?:until|till|til|to|by|at|ends?|ending)\s+(\d{1,2})(?:[:.h ]?(\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)?|\b(\d{1,2})(?:[:.]?(\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)/g;
  while ((m = tRe.exec(d))) {
    let h = Number(m[1] ?? m[4]);
    const min = Number(m[2] ?? m[5] ?? 0);
    const ap = (m[3] ?? m[6] ?? "").replace(/[^ap]/g, "")[0];
    if (h > 23 || min > 59) continue;
    const fmt = (hh: number) => `${String(hh).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    if (ap === "p" && h < 12) h += 12;
    if (ap === "a" && h === 12) h = 0;
    times.push(fmt(h));
    if (!ap && h >= 1 && h <= 11) times.push(fmt(h + 12)); // "until 3" in a cafe usually means 15:00
  }
  // a bare 24h "1200"/"1530" after until/till/by
  const hhmmRe = /\b(?:until|till|til|to|by|at|ends?|ending)\s+([01]?\d|2[0-3])([0-5]\d)\b/g;
  while ((m = hhmmRe.exec(d))) times.push(`${m[1].padStart(2, "0")}:${m[2]}`);
  return { prices, pcts, times };
}

function backing(transcript: string, evidence: Evidence[]) {
  const t = transcript.toLowerCase();
  const prices = new Set<number>();
  const pcts = new Set<number>();
  const times = new Set<string>();
  for (const e of evidence) {
    if (e.field === "new_price" && typeof e.value === "number")
      prices.add(Math.round(e.value * 100));
    if (e.field === "discount_pct" && typeof e.value === "number")
      pcts.add(Math.round(e.value));
    if (e.field === "ends_at" && e.value != null) {
      const n = normTime(e.value);
      if (n) times.add(n);
    }
  }
  const scan = scanTranscript(transcript);
  for (const p of scan.prices) prices.add(Math.round(p * 100));
  for (const p of scan.pcts) pcts.add(Math.round(p));
  for (const x of scan.times) times.add(x);
  // documented derivations
  if (
    /\b(two|2)[\s-]*(for|4)[\s-]*(one|1)\b|\bbogo\b|buy one,? get one|half[\s-]*(price|off)|\b50 ?(%|percent)/.test(
      t,
    )
  )
    pcts.add(50);
  if (/\bfree\b/.test(t)) {
    pcts.add(100);
    prices.add(0);
  }
  if (/\bnoon\b|\bmidday\b/.test(t)) times.add("12:00");
  if (/\bmidnight\b/.test(t)) times.add("00:00");
  return { prices, pcts, times };
}

function check(
  call: PlannedCall,
  menuIds: Set<string>,
  b: ReturnType<typeof backing>,
): string | null {
  if (
    "item_id" in call &&
    call.tool !== "explain" &&
    !menuIds.has(call.item_id)
  )
    return `Unknown menu item "${call.item_id}".`;
  if (
    call.tool === "explain" &&
    call.item_id !== null &&
    !menuIds.has(call.item_id)
  )
    return `Unknown menu item "${call.item_id}".`;
  if (call.tool === "set_price") {
    if (!Number.isFinite(call.price)) return "No price was given.";
    if (!b.prices.has(Math.round(call.price * 100)))
      return `The price ${call.price} was not said.`;
  }
  if (call.tool === "start_promo") {
    if (!Number.isFinite(call.discount_pct)) return "No discount was given.";
    if (!b.pcts.has(Math.round(call.discount_pct)))
      return `The discount ${call.discount_pct}% was not said.`;
    if (call.ends_at !== null) {
      const n = normTime(call.ends_at);
      if (!n || !b.times.has(n))
        return `The end time ${call.ends_at} was not said.`;
      call.ends_at = n;
    }
  }
  return null;
}

// ---------------- entry point ----------------

export async function understand(
  env: Env,
  input: { transcript: string; menu: MenuItem[]; role: Role },
): Promise<Understanding> {
  const transcript = (input.transcript ?? "").trim();
  const t0 = Date.now();
  let extract_ms = 0;
  let plan_ms = 0;
  // extraction and planning are independent: run them in parallel
  const [ex, planned] = await Promise.all([
    extract(env, transcript).finally(() => (extract_ms = Date.now() - t0)),
    plan(env, transcript, input.menu, input.role)
      .catch((e) => {
        console.warn("all planners failed", String(e));
        return [
          {
            tool: "ask_clarification",
            question: "Sorry, I didn't catch that. Could you say it again?",
          } as PlannedCall,
        ];
      })
      .finally(() => (plan_ms = Date.now() - t0)),
  ]);

  const evidence = cleanEvidence(ex.evidence, planned, input.menu);
  const b = backing(transcript, evidence);
  const menuIds = new Set(input.menu.map((m) => m._id));
  const calls: PlannedCall[] = [];
  const rejected: { call: PlannedCall; reason: string }[] = [];
  for (const c of planned) {
    const why = check(c, menuIds, b);
    if (why) rejected.push({ call: c, reason: why });
    else calls.push(c);
  }
  return {
    calls,
    rejected,
    evidence,
    extraction_source: ex.source,
    timings: { extract_ms, plan_ms },
  };
}
