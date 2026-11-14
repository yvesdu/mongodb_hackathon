// Shared contract for Yes Chef. Every module codes against these shapes.
// Owned by the coordinator: propose changes, do not edit unilaterally.

export const SHOP_ID = "shop_demo";
export const AGENT_ID = "agent_yeschef_v1";

export type Role = "owner" | "employee";
export type ActionType =
  "set_price" | "start_promo" | "mark_sold_out" | "mark_available" | "undo";
export type TargetName = "sign" | "menu" | "till";

export type ActionStatus =
  | "proposed" // recorded, not yet judged
  | "blocked" // the gate refused it (final)
  | "pending_approval" // over the speaker's limit; waiting for the owner
  | "rejected" // the owner said no (final)
  | "allowed" // the gate (or the owner's approval) permits it
  | "applying" // being written to targets
  | "applied" // written to all targets
  | "verified" // read back and matching on all targets
  | "failed" // a write or read-back failed; applied targets restored (final)
  | "halted" // kill switch fired mid-run; applied targets restored (final)
  | "rolled_back"; // a later undo restored the previous state (final)

export interface Env {
  YesChefAgent: any; // DurableObjectNamespace
  AI: any; // Workers AI binding
  ASSETS?: any;
  MONGODB_URI: string;
  MONGODB_DB: string;
  ELEVENLABS_API_KEY: string;
  COUNTER_KEY: string; // secret in the counter page link
  OWNER_KEY: string; // secret in the owner's approve link (stands in for a device login)
  DEMO_SLOW: string; // "1" adds a pause between targets so the kill switch can be shown
}

// ---------- Atlas documents ----------

export interface Identity {
  _id: string; // "usr_marie" | "usr_sam" | AGENT_ID
  shop_id: string;
  kind: "human" | "agent";
  name: string;
  role: Role | "agent";
  active: boolean;
}

export interface PolicyConditions {
  max_discount_pct?: number; // params.discount_pct must be <= n
  max_change_pct?: number; // new price within n% of base_price
  min_price?: number; // params.price must be >= n
  missing_fr_text?: boolean; // deny rule: action publishes text and params.text_fr is empty
}

export interface Policy {
  _id: string; // "pol_<rule_id>_v<version>"
  shop_id: string;
  rule_id: string;
  version: number;
  status: "active" | "retired";
  effect: "allow" | "deny";
  actions: (ActionType | "*")[];
  roles: (Role | "*")[];
  conditions: PolicyConditions;
  // What happens when the rule matches the role and action but a numeric limit fails.
  // "needs_approval" means: hold it for the owner if the owner's own rules would allow it.
  over_limit?: "deny" | "needs_approval";
  reason_en: string;
  created_by: string;
  created_at: Date;
}

export interface Promo {
  discount_pct: number;
  text_en: string;
  text_fr: string;
  ends_at: string | null; // "12:00"
  action_id: string;
}

export interface MenuItem {
  _id: string; // "item_coffee"
  shop_id: string;
  name_en: string;
  name_fr: string;
  aliases: string[];
  base_price: number;
  price: number;
  currency: "CAD";
  available: boolean;
  promo: Promo | null;
  last_action_id: string | null;
}

/** What the sign and the online menu show for one item (collections target_sign, target_menu). */
export interface SignDoc {
  _id: string; // item id
  shop_id: string;
  text_en: string;
  text_fr: string; // required by the validator: no sign without French text
  price: number;
  sold_out: boolean;
  promo_en: string | null;
  promo_fr: string | null;
  ends_at: string | null;
  action_id: string; // required by the validator: every sign state traces to an action ("seed" at start)
  updated_at: Date;
}

/** What the till charges (collection target_till). */
export interface TillDoc {
  _id: string;
  shop_id: string;
  price: number;
  available: boolean;
  discount_pct: number | null;
  action_id: string;
  updated_at: Date;
}

export interface Actor {
  human_id: string;
  role: Role;
  agent_id: string;
}

/** One value the extractor pulled from the transcript, with the exact words it came from. */
export interface Evidence {
  field: string; // "item" | "new_price" | "discount_pct" | "ends_at" | "sold_out_item" | ...
  value: string | number | null;
  quote: string | null; // exact words in the transcript
  span: [number, number] | null; // [start, end) character offsets of quote in the transcript
  p_null?: number | null;
  confidence?: number | null;
}

export interface ActionParams {
  item_id?: string;
  price?: number;
  discount_pct?: number;
  text_en?: string;
  text_fr?: string;
  ends_at?: string | null;
}

export interface PolicyDecision {
  decision: "pending" | "allow" | "deny" | "needs_approval";
  rule_id: string | null;
  version: number | null;
  reason: string | null;
  approved_by?: string | null; // human_id of the owner who approved a held action
  approved_at?: string | null; // ISO
}

export interface TargetState {
  name: TargetName;
  status: "pending" | "applied" | "verified" | "reverted";
  previous: Record<string, unknown> | null; // full prior document, saved before the write
  applied_at?: Date;
  verified_at?: Date;
}

export interface ActionDoc {
  _id: string; // "act_<ulid-ish>"
  shop_id: string;
  run_id: string; // one spoken sentence = one run, possibly several actions
  type: ActionType;
  status: ActionStatus;
  actor: Actor;
  utterance: { text: string; lang: "en"; stt: "elevenlabs" | "typed" };
  evidence: Evidence[];
  params: ActionParams;
  policy: PolicyDecision;
  targets: TargetState[];
  undo_of: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AuditEntry {
  shop_id: string;
  seq: number;
  ts: string; // ISO string so the hash is stable
  event: string; // "action.proposed" | "policy.allowed" | "policy.blocked" | "policy.held" | "approval.granted" | ...
  action_id: string | null;
  run_id: string | null;
  actor: Actor | { human_id: string; role: string; agent_id: string };
  detail: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

export interface Control {
  _id: string; // SHOP_ID
  halt: boolean;
  audit_seq: number;
  last_hash: string;
}

// ---------- Brain (src/brain.ts, src/gate.ts) ----------

export type PlannedCall =
  | { tool: "set_price"; item_id: string; price: number }
  | {
      tool: "start_promo";
      item_id: string;
      discount_pct: number;
      text_en: string;
      text_fr: string;
      ends_at: string | null;
    }
  | { tool: "mark_sold_out"; item_id: string }
  | { tool: "mark_available"; item_id: string }
  | { tool: "undo" }
  | { tool: "explain"; item_id: string | null } // "why is coffee two-for-one?"
  | { tool: "ask_clarification"; question: string };

export interface Understanding {
  calls: PlannedCall[]; // only calls that passed the invented-number check
  rejected: { call: PlannedCall; reason: string }[]; // calls whose numbers were not in the transcript
  evidence: Evidence[];
  extraction_source: "clairic" | "fallback";
  timings: { extract_ms: number; plan_ms: number };
}

export interface GateInput {
  type: ActionType;
  params: ActionParams;
  actor: Actor;
  item: MenuItem | null;
  rules: Policy[]; // active rules for the shop
  original?: ActionDoc | null; // for undo: the action being undone
}

// ---------- State pushed to every screen ----------

export interface SignView {
  item_id: string;
  text_en: string;
  text_fr: string;
  price: number;
  sold_out: boolean;
  promo_en: string | null;
  promo_fr: string | null;
  ends_at: string | null;
  action_id: string;
  updated_at: string; // ISO
}

export interface TillView {
  item_id: string;
  price: number;
  available: boolean;
  discount_pct: number | null;
  action_id: string;
}

export interface PendingApproval {
  action_id: string;
  requested_by: string; // display name, e.g. "Sam"
  role: Role;
  summary: string; // "20% off Muffin"
  utterance: string;
  reason: string; // why it was held, e.g. "Employees may run promos up to 10% off."
  created_at: string;
}

export interface TraceStep {
  key:
    "heard" | "extracted" | "planned" | "gate" | "target" | "verified" | "note";
  label: string; // short, human readable
  status: "ok" | "blocked" | "held" | "info" | "fail";
  detail?: string;
}

export interface RunTrace {
  run_id: string;
  speaker: string; // "Marie"
  role: Role;
  text: string; // what was heard
  steps: TraceStep[];
  say: string | null; // the spoken reply
  done: boolean;
}

export interface ShopState {
  sign: SignView[];
  menu: SignView[];
  till: TillView[];
  halted: boolean;
  pending: PendingApproval[];
  trace: RunTrace | null;
  updatedAt: number;
}

export interface Snapshot {
  sign: SignView[];
  menu: SignView[];
  till: TillView[];
  halted: boolean;
  pending: PendingApproval[];
}

// ---------- HTTP API results ----------

export interface UtteranceResult {
  run_id: string;
  results: {
    action_id: string | null;
    type: string;
    status: ActionStatus | "clarify" | "explained" | "none";
    reason: string | null;
    item_id: string | null;
  }[];
  say: string; // text to speak back
}

export interface RecordView {
  action: Record<string, unknown>; // ActionDoc with dates as ISO strings
  audit: AuditEntry[];
  speaker_name: string;
  item_name: string | null;
  chain: { ok: boolean; entries: number; broken_at: number | null };
}
