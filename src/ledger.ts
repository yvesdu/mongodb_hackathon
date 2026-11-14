// Yes Chef ledger: every read and write against Atlas. Runs in Node and in a Cloudflare
// Worker / Durable Object: uses only the `mongodb` driver and Web Crypto.
import type { AnyClientBulkWriteModel, ClientSession, Db } from "mongodb";
import {
  AGENT_ID,
  SHOP_ID,
  type ActionDoc,
  type ActionParams,
  type ActionStatus,
  type ActionType,
  type Actor,
  type AuditEntry,
  type Evidence,
  type Identity,
  type MenuItem,
  type PendingApproval,
  type Policy,
  type PolicyDecision,
  type RecordView,
  type SignView,
  type Snapshot,
  type TargetName,
  type TillView,
  type TraceStep,
} from "./types.ts";

type AnyDoc = Record<string, any>;
type AuditActor = AuditEntry["actor"];

const ORDER: TargetName[] = ["sign", "menu", "till"];
const COLL: Record<TargetName, string> = {
  sign: "target_sign",
  menu: "target_menu",
  till: "target_till",
};
const ITEM_ORDER = [
  "item_coffee",
  "item_latte",
  "item_croissant",
  "item_muffin",
];
const SHOP_TZ = "America/Toronto";

// ---------- small helpers ----------

/** Deep copy dropping undefined (never stored), keeping Dates. */
function clean<T>(v: T): T {
  if (v === undefined) return null as T;
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Date) return v;
  if (Array.isArray(v))
    return v.map((x) => (x === undefined ? null : clean(x))) as T;
  const out: AnyDoc = {};
  for (const [k, x] of Object.entries(v as AnyDoc))
    if (x !== undefined) out[k] = clean(x);
  return out as T;
}

/** Deep copy with Dates as ISO strings and ObjectIds as strings. */
function toPlain(v: any): any {
  if (v === null || v === undefined) return v ?? null;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(toPlain);
  if (typeof v === "object") {
    if (v._bsontype === "ObjectId" || v._bsontype === "ObjectID")
      return String(v);
    const out: AnyDoc = {};
    for (const [k, x] of Object.entries(v))
      if (x !== undefined) out[k] = toPlain(x);
    return out;
  }
  return v;
}

/** Canonical JSON: keys sorted recursively, undefined dropped. */
function canonical(v: any): string {
  const norm = (x: any): any => {
    if (x === null || x === undefined) return null;
    if (x instanceof Date) return x.toISOString();
    if (Array.isArray(x)) return x.map(norm);
    if (typeof x === "object") {
      if (x._bsontype === "ObjectId") return String(x);
      const out: AnyDoc = {};
      for (const k of Object.keys(x).sort())
        if (x[k] !== undefined) out[k] = norm(x[k]);
      return out;
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function entryHash(entry: AnyDoc): Promise<string> {
  const { _id, hash, ...rest } = entry;
  return sha256(String(rest.prev_hash) + canonical(rest));
}

function newId(prefix: string): string {
  const rnd = new Uint8Array(6);
  crypto.getRandomValues(rnd);
  return `${prefix}_${Date.now().toString(36)}${[...rnd]
    .map((b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 8)}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function agentActor(): AuditActor {
  return { human_id: AGENT_ID, role: "agent", agent_id: AGENT_ID };
}

async function inTxn<T>(
  db: Db,
  fn: (s: ClientSession) => Promise<T>,
): Promise<T> {
  const session = db.client.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async (s) => {
      result = await fn(s);
    });
    return result as T;
  } finally {
    await session.endSession();
  }
}

interface AuditInput {
  event: string;
  action_id?: string | null;
  run_id?: string | null;
  actor: AuditActor;
  detail?: Record<string, unknown>;
}

// ---------- chain head cache and one-round-trip transactions ----------

interface Head {
  seq: number;
  hash: string;
}
/** Chain head per database. The Durable Object is the only writer; a stale head is detected and re-read once. */
const HEADS = new Map<string, Head>();

async function readHead(db: Db): Promise<Head> {
  const ctl = await db
    .collection<AnyDoc>("control")
    .findOne({ _id: SHOP_ID }, { projection: { audit_seq: 1, last_hash: 1 } });
  const head = { seq: ctl?.audit_seq ?? 0, hash: ctl?.last_hash ?? "genesis" };
  HEADS.set(db.databaseName, head);
  return head;
}

async function ensureHead(db: Db): Promise<Head> {
  return HEADS.get(db.databaseName) ?? readHead(db);
}

class StaleChain extends Error {}
class WrongStatus extends Error {}

interface Op {
  model: AnyClientBulkWriteModel<AnyDoc>;
  mustMatch?: string; // error message if this update matches nothing
}

function isDupKey(e: any): boolean {
  if (e?.code === 11000) return true;
  const we = e?.writeErrors;
  if (we && typeof we.values === "function")
    for (const w of we.values()) if (w?.code === 11000) return true;
  return /E11000/.test(String(e?.message ?? ""));
}

async function buildEntries(head: Head, list: AuditInput[]): Promise<AnyDoc[]> {
  let prevHash = head.hash;
  let seq = head.seq;
  const ts = new Date().toISOString();
  const out: AnyDoc[] = [];
  for (const e of list) {
    const entry: AnyDoc = clean({
      shop_id: SHOP_ID,
      seq: ++seq,
      ts,
      event: e.event,
      action_id: e.action_id ?? null,
      run_id: e.run_id ?? null,
      actor: {
        human_id: e.actor.human_id,
        role: e.actor.role,
        agent_id: e.actor.agent_id,
      },
      detail: toPlain(e.detail ?? {}),
      prev_hash: prevHash,
    });
    entry.hash = await entryHash(entry);
    prevHash = entry.hash;
    out.push(entry);
  }
  return out;
}

/**
 * One transaction = one client.bulkWrite (all ops + audit inserts + control compare-and-swap) + commit.
 * If the cached chain head is stale, re-read control and try once more.
 */
async function txWrite(
  db: Db,
  ops: Op[],
  audits: AuditInput[],
): Promise<AuditEntry[]> {
  const ns = (c: string) => `${db.databaseName}.${c}`;
  for (let attempt = 0; ; attempt++) {
    const head = attempt === 0 ? await ensureHead(db) : await readHead(db);
    const entries = await buildEntries(head, audits);
    const models: AnyClientBulkWriteModel<AnyDoc>[] = ops.map((o) => o.model);
    for (const e of entries)
      models.push({ name: "insertOne", namespace: ns("audit"), document: e });
    const casIdx = models.length;
    const newHead = entries.length
      ? {
          seq: head.seq + entries.length,
          hash: entries[entries.length - 1].hash,
        }
      : head;
    if (entries.length) {
      models.push({
        name: "updateOne",
        namespace: ns("control"),
        filter: { _id: SHOP_ID, audit_seq: head.seq },
        update: { $set: { audit_seq: newHead.seq, last_hash: newHead.hash } },
      });
    }
    try {
      await inTxn(db, async (session) => {
        const r = await db.client.bulkWrite(models, {
          session,
          ordered: true,
          verboseResults: true,
        });
        ops.forEach((o, i) => {
          if (o.mustMatch && (r.updateResults?.get(i)?.matchedCount ?? 0) !== 1)
            throw new WrongStatus(o.mustMatch);
        });
        if (
          entries.length &&
          (r.updateResults?.get(casIdx)?.matchedCount ?? 0) !== 1
        )
          throw new StaleChain("chain head moved");
      });
      HEADS.set(db.databaseName, newHead);
      for (const e of entries) delete e._id;
      return entries as AuditEntry[];
    } catch (e) {
      if (attempt === 0 && (e instanceof StaleChain || isDupKey(e))) continue;
      throw e;
    }
  }
}

const actions = (db: Db) => db.collection<ActionDoc>("actions");

async function getAction(db: Db, id: string): Promise<ActionDoc> {
  const a = await actions(db).findOne({ _id: id });
  if (!a) throw new Error(`action ${id} not found`);
  return a;
}

/** Apply a $set (dotted paths allowed) to an in-memory copy. */
function applySet<T>(doc: T, set: AnyDoc): T {
  const out: AnyDoc = clean(doc as AnyDoc);
  for (const [path, v] of Object.entries(set)) {
    const parts = path.split(".");
    let cur = out;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] === null || typeof cur[parts[i]] !== "object")
        cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = v;
  }
  return out as T;
}

/**
 * One state step: filtered action update (status must be one of `expected`) + audit + chain head,
 * plus any extra ops, in one transaction (bulkWrite + commit). Returns the updated doc built in memory.
 */
async function step(
  db: Db,
  a: ActionDoc,
  expected: ActionStatus | ActionStatus[],
  set: AnyDoc,
  audits: AuditInput[],
  extra: Op[] = [],
): Promise<ActionDoc> {
  const exp = Array.isArray(expected) ? expected : [expected];
  const fullSet = clean({ ...set, updated_at: new Date() });
  await txWrite(
    db,
    [
      {
        model: {
          name: "updateOne",
          namespace: `${db.databaseName}.actions`,
          filter: { _id: a._id, status: { $in: exp } },
          update: { $set: fullSet },
        },
        mustMatch: `action ${a._id} is missing or not ${exp.join("|")}`,
      },
      ...extra,
    ],
    audits.map((e) => ({
      ...e,
      action_id: e.action_id ?? a._id,
      run_id: e.run_id ?? a.run_id,
    })),
  );
  return applySet(a, fullSet);
}

// ---------- reads ----------

export async function loadRules(db: Db): Promise<Policy[]> {
  return db
    .collection<Policy>("policies")
    .find({ shop_id: SHOP_ID, status: "active" })
    .toArray();
}

export async function loadMenu(db: Db): Promise<MenuItem[]> {
  const items = await db
    .collection<MenuItem>("menu_items")
    .find({ shop_id: SHOP_ID })
    .toArray();
  return items.sort(byItemOrder);
}

export async function getIdentity(
  db: Db,
  human_id: string,
): Promise<Identity | null> {
  return db.collection<Identity>("identities").findOne({ _id: human_id });
}

export async function isHalted(db: Db): Promise<boolean> {
  const c = await db
    .collection<AnyDoc>("control")
    .findOne({ _id: SHOP_ID }, { projection: { halt: 1 } });
  return !!c?.halt;
}

function byItemOrder(a: { _id: string }, b: { _id: string }): number {
  const ia = ITEM_ORDER.indexOf(a._id),
    ib = ITEM_ORDER.indexOf(b._id);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a._id.localeCompare(b._id);
}

// ---------- writes ----------

export async function setHalt(
  db: Db,
  halt: boolean,
  actor: Actor,
): Promise<void> {
  await txWrite(
    db,
    [
      {
        model: {
          name: "updateOne",
          namespace: `${db.databaseName}.control`,
          filter: { _id: SHOP_ID },
          update: { $set: { halt } },
        },
      },
    ],
    [{ event: halt ? "halt.set" : "halt.cleared", actor, detail: { halt } }],
  );
}

export async function auditEvent(db: Db, e: AuditInput): Promise<void> {
  await txWrite(db, [], [e]);
}

interface ProposeInput {
  run_id: string;
  type: ActionType;
  actor: Actor;
  utterance: ActionDoc["utterance"];
  evidence: Evidence[];
  params: ActionParams;
  undo_of?: string | null;
}

function decisionStatus(d: PolicyDecision): {
  status: ActionStatus;
  event: string;
  policy: PolicyDecision;
} {
  const status: ActionStatus =
    d.decision === "allow"
      ? "allowed"
      : d.decision === "needs_approval"
        ? "pending_approval"
        : "blocked";
  const event =
    status === "allowed"
      ? "policy.allowed"
      : status === "pending_approval"
        ? "policy.held"
        : "policy.blocked";
  const policy = clean({
    decision: d.decision === "pending" ? "deny" : d.decision,
    rule_id: d.rule_id ?? null,
    version: d.version ?? null,
    reason: d.reason ?? null,
  }) as PolicyDecision;
  return { status, event, policy };
}

function decisionAudit(
  actor: Actor,
  event: string,
  policy: PolicyDecision,
): AuditInput {
  return {
    event,
    actor,
    detail: {
      decision: policy.decision,
      rule_id: policy.rule_id,
      version: policy.version,
      reason: policy.reason,
    },
  };
}

/** Actions this process began publishing (proposeDecided with begin), so publish() can skip a read. */
const BEGUN = new Map<string, ActionDoc>();

async function insertAction(
  db: Db,
  input: ProposeInput,
  decision: PolicyDecision | null,
  begin: boolean,
): Promise<ActionDoc> {
  const now = new Date();
  const judged = decision ? decisionStatus(decision) : null;
  const canBegin =
    begin &&
    judged?.status === "allowed" &&
    input.type !== "undo" &&
    !!input.params?.item_id;
  const [ident, currents] = await Promise.all([
    getIdentity(db, input.actor.human_id),
    canBegin
      ? Promise.all(
          ORDER.map((n) =>
            db
              .collection<AnyDoc>(COLL[n])
              .findOne({ _id: input.params.item_id! }),
          ),
        )
      : Promise.resolve(null),
    ensureHead(db),
  ]);
  const status: ActionStatus = canBegin
    ? "applying"
    : judged
      ? judged.status
      : "proposed";
  const doc: ActionDoc = clean({
    _id: newId("act"),
    shop_id: SHOP_ID,
    run_id: input.run_id,
    type: input.type,
    status,
    actor: {
      human_id: input.actor.human_id,
      role: input.actor.role,
      agent_id: input.actor.agent_id || AGENT_ID,
    },
    utterance: {
      text: input.utterance?.text ?? "",
      lang: "en",
      stt: input.utterance?.stt ?? "typed",
    },
    evidence: input.evidence ?? [],
    params: input.params ?? {},
    policy: judged
      ? judged.policy
      : { decision: "pending", rule_id: null, version: null, reason: null },
    targets: ORDER.map((name, i) => ({
      name,
      status: "pending",
      previous: currents ? (currents[i] ?? null) : null,
    })),
    undo_of: input.undo_of ?? null,
    created_at: now,
    updated_at: now,
  } as ActionDoc);
  const ids = { action_id: doc._id, run_id: doc.run_id };
  const audits: AuditInput[] = [
    {
      event: "action.proposed",
      ...ids,
      actor: doc.actor,
      detail: clean({
        type: doc.type,
        params: doc.params,
        utterance: doc.utterance.text,
        speaker_name: ident?.name ?? doc.actor.human_id,
        undo_of: doc.undo_of,
      }),
    },
  ];
  if (judged)
    audits.push({
      ...decisionAudit(doc.actor, judged.event, judged.policy),
      ...ids,
    });
  if (canBegin)
    audits.push({
      event: "action.applying",
      ...ids,
      actor: doc.actor,
      detail: { type: doc.type, item_id: doc.params.item_id },
    });
  await txWrite(
    db,
    [
      {
        model: {
          name: "insertOne",
          namespace: `${db.databaseName}.actions`,
          document: doc,
        },
      },
    ],
    audits,
  );
  if (canBegin) BEGUN.set(doc._id, doc);
  return doc;
}

export async function proposeAction(
  db: Db,
  input: ProposeInput,
): Promise<ActionDoc> {
  return insertAction(db, input, null, false);
}

/**
 * Insert the action already judged (allowed | blocked | pending_approval) with its audit entries, one transaction.
 * With `begin: true` and an allow decision (not undo), it also reads the three targets, stores `previous`
 * and records action.applying in the same transaction: the returned status is then "applying",
 * and the caller must call publish() next (in this process).
 */
export async function proposeDecided(
  db: Db,
  input: ProposeInput & { decision: PolicyDecision; begin?: boolean },
): Promise<ActionDoc> {
  const { decision, begin, ...rest } = input;
  return insertAction(db, rest, decision, !!begin);
}

export async function recordDecision(
  db: Db,
  action_id: string,
  decision: PolicyDecision,
): Promise<ActionDoc> {
  const a = await getAction(db, action_id);
  const { status, event, policy } = decisionStatus(decision);
  return step(db, a, "proposed", { status, policy }, [
    decisionAudit(a.actor, event, policy),
  ]);
}

export async function resolveApproval(
  db: Db,
  action_id: string,
  input: { approve: boolean; approver: { human_id: string; role: string } },
): Promise<ActionDoc> {
  const [a, ident] = await Promise.all([
    getAction(db, action_id),
    getIdentity(db, input.approver.human_id),
  ]);
  const actor = {
    human_id: input.approver.human_id,
    role: input.approver.role,
    agent_id: AGENT_ID,
  } as Actor;
  const approver_name = ident?.name ?? input.approver.human_id;
  if (input.approve) {
    const at = new Date().toISOString();
    return step(
      db,
      a,
      "pending_approval",
      {
        status: "allowed",
        "policy.decision": "allow",
        "policy.approved_by": input.approver.human_id,
        "policy.approved_at": at,
      },
      [
        {
          event: "approval.granted",
          actor,
          detail: {
            approver_name,
            rule_id: a.policy.rule_id,
            version: a.policy.version,
            reason: a.policy.reason,
          },
        },
      ],
    );
  }
  return step(db, a, "pending_approval", { status: "rejected" }, [
    {
      event: "approval.denied",
      actor,
      detail: {
        approver_name,
        rule_id: a.policy.rule_id,
        version: a.policy.version,
      },
    },
  ]);
}

// ---------- publishing ----------

/** The fields one action sets on one target. */
function changesFor(
  type: ActionType,
  p: ActionParams,
  target: TargetName,
): AnyDoc {
  const till = target === "till";
  switch (type) {
    case "set_price":
      return { price: Number(p.price) };
    case "start_promo":
      return till
        ? { discount_pct: Number(p.discount_pct) }
        : {
            promo_en: p.text_en ?? null,
            promo_fr: p.text_fr ?? null,
            ends_at: p.ends_at ?? null,
          };
    case "mark_sold_out":
      return till ? { available: false } : { sold_out: true };
    case "mark_available":
      return till ? { available: true } : { sold_out: false };
    default:
      return {};
  }
}

/** Content fields compared on read-back (everything but bookkeeping). */
function contentOf(doc: AnyDoc | null): AnyDoc {
  if (!doc) return {};
  const { _id, updated_at, action_id, ...rest } = doc;
  return rest;
}

function sameFields(actual: AnyDoc | null, expected: AnyDoc): boolean {
  if (!actual) return false;
  return Object.keys(expected).every(
    (k) => canonical(actual[k] ?? null) === canonical(expected[k] ?? null),
  );
}

const TARGET_LABEL: Record<TargetName, string> = {
  sign: "Sign",
  menu: "Online menu",
  till: "Till",
};

interface PublishOpts {
  slowMs?: number;
  onStep?: (s: TraceStep) => void | Promise<void>;
}

/** One planned target write: which target, the doc before, and what to write. */
interface Plan {
  idx: number; // index in action.targets
  name: TargetName;
  previous: AnyDoc | null;
  write: (
    coll: ReturnType<Db["collection"]>,
    item_id: string,
  ) => Promise<unknown>;
  expect: AnyDoc; // fields that must read back
  detail: AnyDoc; // audit detail for target.applied
}

interface Written {
  plan: Plan;
  at: string; // ISO write time
}

interface Finish {
  set: AnyDoc;
  audits: AuditInput[];
  extra: (menuBefore: AnyDoc | null) => Op[];
  label: string;
}

/**
 * Shared engine for publish and undo; the action is already "applying" with `previous` stored.
 * Round trips: per target (halt read + write), 1 parallel read-back (+ menu_items), 1 transaction.
 */
async function runPlans(
  db: Db,
  a: ActionDoc,
  item_id: string,
  plans: Plan[],
  opts: PublishOpts,
  finish: Finish,
): Promise<ActionDoc> {
  const action_id = a._id;
  const sys = agentActor();
  const written: Written[] = [];
  for (const p of plans) {
    if (await isHalted(db))
      return compensate(db, a, item_id, written, "halted", opts);
    const coll = db.collection<AnyDoc>(COLL[p.name]);
    try {
      const r = (await p.write(coll as any, item_id)) as AnyDoc;
      if (r && r.matchedCount === 0)
        throw new Error(`${p.name} has no document for ${item_id}`);
    } catch (err) {
      await opts.onStep?.({
        key: "target",
        label: `${TARGET_LABEL[p.name]} write failed`,
        status: "fail",
        detail: errText(err),
      });
      written.push({ plan: p, at: new Date().toISOString() });
      return compensate(db, a, item_id, written, "failed", opts, errText(err));
    }
    written.push({ plan: p, at: new Date().toISOString() });
    await opts.onStep?.({
      key: "target",
      label: `${TARGET_LABEL[p.name]} ${a.type === "undo" ? "restored" : "updated"}`,
      status: "ok",
      detail: describeChanges(p.detail.changes ?? {}),
    });
    if (opts.slowMs) await sleep(opts.slowMs);
  }

  const [now, menuBefore] = await Promise.all([
    Promise.all(
      plans.map((p) =>
        db.collection<AnyDoc>(COLL[p.name]).findOne({ _id: item_id }),
      ),
    ),
    db.collection<AnyDoc>("menu_items").findOne({ _id: item_id }),
  ]);
  const bad = plans.findIndex(
    (p, i) =>
      !now[i] ||
      now[i]!.action_id !== action_id ||
      !sameFields(now[i], p.expect),
  );
  if (bad >= 0) {
    await opts.onStep?.({
      key: "verified",
      label: `${TARGET_LABEL[plans[bad].name]} read-back mismatch`,
      status: "fail",
    });
    return compensate(
      db,
      a,
      item_id,
      written,
      "failed",
      opts,
      `${plans[bad].name} read-back mismatch`,
    );
  }

  const verifiedAt = new Date();
  const extraOps = finish.extra(menuBefore);
  const set: AnyDoc = { ...finish.set };
  const audits: AuditInput[] = [];
  for (const w of written) {
    set[`targets.${w.plan.idx}.status`] = "verified";
    set[`targets.${w.plan.idx}.applied_at`] = new Date(w.at);
    set[`targets.${w.plan.idx}.verified_at`] = verifiedAt;
    audits.push({
      event: "target.applied",
      actor: sys,
      detail: {
        ...w.plan.detail,
        target: w.plan.name,
        item_id,
        written_at: w.at,
      },
    });
  }
  for (const w of written)
    audits.push({
      event: "target.verified",
      actor: sys,
      detail: { target: w.plan.name, item_id },
    });
  audits.push(...finish.audits);
  const done = await step(
    db,
    a,
    "applying",
    set,
    audits, extraOps);
  await opts.onStep?.({ key: "verified", label: finish.label, status: "ok" });
  return done;
}

/** Restore written targets from `previous` (in parallel), then one transaction for the audit and final status. */
async function compensate(
  db: Db,
  a: ActionDoc,
  item_id: string,
  written: Written[],
  final: "halted" | "failed",
  opts: PublishOpts,
  why?: string,
): Promise<ActionDoc> {
  const sys = agentActor();
  const toRestore = [...written].reverse();
  await Promise.all(
    toRestore.map((w) => {
      const coll = db.collection<AnyDoc>(COLL[w.plan.name]);
      return w.plan.previous
        ? coll.replaceOne({ _id: item_id }, clean(w.plan.previous))
        : coll.deleteOne({ _id: item_id });
    }),
  );
  const set: AnyDoc = { status: final };
  const audits: AuditInput[] = [];
  for (const w of written) {
    audits.push({
      event: "target.applied",
      actor: sys,
      detail: {
        ...w.plan.detail,
        target: w.plan.name,
        item_id,
        written_at: w.at,
      },
    });
  }
  for (const w of toRestore) {
    set[`targets.${w.plan.idx}.status`] = "reverted";
    set[`targets.${w.plan.idx}.applied_at`] = new Date(w.at);
    audits.push({
      event: "target.reverted",
      actor: sys,
      detail: {
        target: w.plan.name,
        item_id,
        restored_action_id: w.plan.previous?.action_id ?? null,
      },
    });
  }
  audits.push({
    event: `action.${final}`,
    actor: sys,
    detail: why ? { reason: why } : {},
  });
  const done = await step(db, a, "applying", set, audits);
  for (const w of toRestore) {
    await opts.onStep?.({
      key: "target",
      label: `${TARGET_LABEL[w.plan.name]} restored`,
      status: "info",
    });
  }
  await opts.onStep?.({
    key: "note",
    label:
      final === "halted"
        ? "Stopped by the kill switch; nothing left half-published"
        : "Failed; targets restored",
    status: "fail",
    detail: why,
  });
  return done;
}

export async function publish(
  db: Db,
  action_id: string,
  opts: PublishOpts = {},
): Promise<ActionDoc> {
  let a = BEGUN.get(action_id) ?? null;
  BEGUN.delete(action_id);
  if (!a) {
    a = await getAction(db, action_id);
    if (a.status !== "allowed")
      throw new Error(`action ${action_id} is ${a.status}, expected allowed`);
  }
  if (a.type === "undo") return publishUndo(db, a, opts);
  const item_id = a.params.item_id;
  if (!item_id) throw new Error(`action ${action_id} has no item_id`);
  const sys = agentActor();

  if (a.status === "allowed") {
    // Not begun by proposeDecided: read the targets, then one transaction to start.
    const currents = await Promise.all(
      ORDER.map((n) =>
        db.collection<AnyDoc>(COLL[n]).findOne({ _id: item_id }),
      ),
    );
    const startSet: AnyDoc = { status: "applying" };
    ORDER.forEach(
      (_, i) => (startSet[`targets.${i}.previous`] = currents[i] ?? null),
    );
    a = await step(db, a, "allowed", startSet, [
      {
        event: "action.applying",
        actor: a.actor,
        detail: { type: a.type, item_id },
      },
    ]);
  }
  const act = a;
  const plans: Plan[] = ORDER.map((name, idx) => {
    const changes = changesFor(act.type, act.params, name);
    return {
      idx,
      name,
      previous: (act.targets[idx]?.previous as AnyDoc | null) ?? null,
      expect: changes,
      detail: { changes },
      write: (coll, id) =>
        coll.updateOne({ _id: id } as any, {
          $set: { ...changes, action_id, updated_at: new Date() },
        }),
    };
  });

  const menuSet: AnyDoc = { last_action_id: action_id };
  if (a.type === "set_price") menuSet.price = Number(a.params.price);
  if (a.type === "start_promo")
    menuSet.promo = {
      discount_pct: Number(a.params.discount_pct),
      text_en: a.params.text_en ?? "",
      text_fr: a.params.text_fr ?? "",
      ends_at: a.params.ends_at ?? null,
      action_id,
    };
  if (a.type === "mark_sold_out") menuSet.available = false;
  if (a.type === "mark_available") menuSet.available = true;

  let menuPrevious: AnyDoc | null = null;
  return runPlans(db, a, item_id, plans, opts, {
    get set() {
      return { status: "verified", menu_previous: menuPrevious };
    },
    audits: [
      {
        event: "action.verified",
        actor: sys,
        detail: { item_id, menu: menuSet },
      },
    ],
    extra: (menuBefore) => {
      menuPrevious = menuBefore ?? null;
      return [
        {
          model: {
            name: "updateOne",
            namespace: `${db.databaseName}.menu_items`,
            filter: { _id: item_id },
            update: { $set: clean(menuSet) },
          },
        },
      ];
    },
    label: "Read back on sign, menu and till",
  });
}

async function publishUndo(
  db: Db,
  u: ActionDoc,
  opts: PublishOpts,
): Promise<ActionDoc> {
  const action_id = u._id;
  if (!u.undo_of) throw new Error(`undo ${action_id} has no undo_of`);
  const orig = await getAction(db, u.undo_of);
  if (orig.status !== "verified")
    throw new Error(`cannot undo ${orig._id}: it is ${orig.status}`);
  const item_id = orig.params.item_id!;
  const sys = agentActor();

  const order = [...ORDER].reverse();
  const currents = await Promise.all(
    order.map((n) => db.collection<AnyDoc>(COLL[n]).findOne({ _id: item_id })),
  );
  const plans: Plan[] = [];
  order.forEach((name, k) => {
    const prevOrig = orig.targets.find((t) => t.name === name)
      ?.previous as AnyDoc | null;
    if (!prevOrig) return;
    const idx = ORDER.indexOf(name);
    const { updated_at, ...base } = prevOrig;
    plans.push({
      idx,
      name,
      previous: currents[k] ?? null,
      expect: contentOf(prevOrig),
      detail: { restored_from: orig._id },
      write: (coll, id) =>
        coll.replaceOne(
          { _id: id } as any,
          clean({ ...base, action_id, updated_at: new Date() }),
        ),
    });
  });
  const startSet: AnyDoc = { status: "applying", "params.item_id": item_id };
  for (const p of plans) startSet[`targets.${p.idx}.previous`] = p.previous;
  const a = await step(db, u, "allowed", startSet, [
    {
      event: "action.applying",
      actor: u.actor,
      detail: { type: "undo", undo_of: orig._id, item_id },
    },
  ]);

  const menuPrev = (orig as AnyDoc).menu_previous as AnyDoc | null;
  return runPlans(db, a, item_id, plans, opts, {
    set: { status: "verified" },
    audits: [
      {
        event: "action.verified",
        actor: sys,
        detail: { item_id, undo_of: orig._id },
      },
      {
        event: "action.rolled_back",
        action_id: orig._id,
        run_id: orig.run_id,
        actor: u.actor,
        detail: { undo_action_id: action_id },
      },
    ],
    extra: () => {
      const ops: Op[] = [
        {
          model: {
            name: "updateOne",
            namespace: `${db.databaseName}.actions`,
            filter: { _id: orig._id, status: "verified" },
            update: {
              $set: {
                status: "rolled_back",
                rolled_back_by: action_id,
                updated_at: new Date(),
              },
            },
          },
          mustMatch: `original ${orig._id} is no longer verified`,
        },
      ];
      if (menuPrev) {
        ops.push({
          model: {
            name: "replaceOne",
            namespace: `${db.databaseName}.menu_items`,
            filter: { _id: item_id },
            replacement: clean({ ...menuPrev, last_action_id: action_id }),
          },
        });
      }
      return ops;
    },
    label: "Undo read back on sign, menu and till",
  });
}
function errText(err: unknown): string {
  const e = err as AnyDoc;
  const details = e?.errInfo?.details;
  return details
    ? `${e.message}: ${JSON.stringify(details)}`
    : String(e?.message ?? err);
}

function describeChanges(c: AnyDoc): string {
  return Object.entries(c)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}
export async function findLastUndoable(db: Db): Promise<ActionDoc | null> {
  return actions(db).findOne(
    { shop_id: SHOP_ID, status: "verified", type: { $ne: "undo" } },
    { sort: { created_at: -1 } },
  );
}

// ---------- explaining and viewing ----------

function itemNoun(name: string): { subj: string; verb: string } {
  const lower = name.toLowerCase();
  if (lower === "coffee" || lower.endsWith("ee"))
    return { subj: name, verb: "is" };
  return { subj: name.endsWith("s") ? name : `${name}s`, verb: "are" };
}

function spokenTime(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: SHOP_TZ,
    })
      .format(date)
      .replace(/\s?[AP]M$/i, "");
  } catch {
    return date.toISOString().slice(11, 16);
  }
}

function money(n: number): string {
  return `$${Number(n).toFixed(2)}`;
}

function summarize(
  type: ActionType,
  p: ActionParams,
  itemName: string,
): string {
  switch (type) {
    case "start_promo":
      return `${p.discount_pct}% off ${itemName}`;
    case "set_price":
      return `${itemName} at ${money(p.price ?? 0)}`;
    case "mark_sold_out":
      return `${itemName} sold out`;
    case "mark_available":
      return `${itemName} back on`;
    default:
      return `undo ${itemName}`;
  }
}

async function itemName(
  db: Db,
  item_id: string | null | undefined,
): Promise<string | null> {
  if (!item_id) return null;
  const m = await db
    .collection<AnyDoc>("menu_items")
    .findOne({ _id: item_id }, { projection: { name_en: 1 } });
  return m?.name_en ?? item_id.replace(/^item_/, "");
}

export async function explain(
  db: Db,
  item_id: string | null,
): Promise<{ text: string; action_id: string | null }> {
  const nothing = {
    text: "Nothing has changed that item today.",
    action_id: null,
  };
  let action: ActionDoc | null = null;
  if (item_id) {
    const sign = await db
      .collection<AnyDoc>("target_sign")
      .findOne({ _id: item_id });
    if (!sign || !sign.action_id || sign.action_id === "seed") return nothing;
    action = await actions(db).findOne({ _id: sign.action_id });
  } else {
    action = await actions(db).findOne(
      { shop_id: SHOP_ID, status: "verified" },
      { sort: { created_at: -1 } },
    );
  }
  if (!action)
    return item_id
      ? nothing
      : { text: "Nothing has changed today.", action_id: null };

  const [audit, original] = await Promise.all([
    db
      .collection<AuditEntry>("audit")
      .find({ action_id: action._id }, { sort: { seq: 1 } })
      .toArray(),
    action.type === "undo" && action.undo_of
      ? actions(db).findOne({ _id: action.undo_of })
      : Promise.resolve(null),
  ]);
  const ev = (name: string) => audit.find((e) => e.event === name);
  const proposed = ev("action.proposed");
  const speaker = String(
    proposed?.detail?.speaker_name ?? action.actor.human_id,
  );
  const target_item =
    action.params.item_id ?? original?.params.item_id ?? item_id;
  const name = (await itemName(db, target_item)) ?? "That item";
  const { subj, verb } = itemNoun(name);
  const at = spokenTime(action.created_at);

  const parts: string[] = [];
  const p = action.params;
  switch (action.type) {
    case "start_promo":
      parts.push(
        `${subj} ${verb} ${p.discount_pct} percent off because ${speaker} asked for it at ${at}.`,
      );
      break;
    case "set_price":
      parts.push(
        `${subj} ${verb} ${money(p.price ?? 0)} because ${speaker} asked for it at ${at}.`,
      );
      break;
    case "mark_sold_out":
      parts.push(
        `${subj} ${verb} marked sold out because ${speaker} said so at ${at}.`,
      );
      break;
    case "mark_available":
      parts.push(
        `${subj} ${verb} back on because ${speaker} said so at ${at}.`,
      );
      break;
    case "undo": {
      const what = original
        ? summarize(original.type, original.params, name)
        : "the last change";
      parts.push(
        `${subj} ${verb} back to how it was because ${speaker} asked to undo ${what} at ${at}.`,
      );
      break;
    }
  }

  const held = ev("policy.held");
  const granted = ev("approval.granted");
  const allowed = ev("policy.allowed");
  if (held) {
    const reason = String(
      held.detail?.reason ?? "it was over the speaker's limit",
    );
    parts.push(`${reason.replace(/\.$/, "")}, so it was held.`);
    if (granted)
      parts.push(
        `${String(granted.detail?.approver_name ?? granted.actor.human_id)} approved it.`,
      );
  } else if (allowed) {
    const rule = String(allowed.detail?.rule_id ?? "a rule").replace(/_/g, " ");
    parts.push(
      `The ${rule} rule, version ${allowed.detail?.version ?? 1}, allowed it.`,
    );
  }

  const verified = new Set(
    audit
      .filter((e) => e.event === "target.verified")
      .map((e) => String(e.detail?.target)),
  );
  const names = ORDER.filter((t) => verified.has(t)).map((t) =>
    t === "sign" ? "the sign" : t === "menu" ? "the menu" : "the till",
  );
  if (names.length === 3)
    parts.push(
      "The sign, the menu and the till were each written and read back.",
    );
  else if (names.length)
    parts.push(
      `${names.join(" and ")} ${names.length > 1 ? "were" : "was"} written and read back.`.replace(
        /^t/,
        "T",
      ),
    );

  return { text: parts.join(" "), action_id: action._id };
}

function signView(d: AnyDoc): SignView {
  return {
    item_id: String(d._id),
    text_en: d.text_en,
    text_fr: d.text_fr,
    price: d.price,
    sold_out: !!d.sold_out,
    promo_en: d.promo_en ?? null,
    promo_fr: d.promo_fr ?? null,
    ends_at: d.ends_at ?? null,
    action_id: d.action_id,
    updated_at:
      d.updated_at instanceof Date
        ? d.updated_at.toISOString()
        : String(d.updated_at ?? ""),
  };
}

function tillView(d: AnyDoc): TillView {
  return {
    item_id: String(d._id),
    price: d.price,
    available: !!d.available,
    discount_pct: d.discount_pct ?? null,
    action_id: d.action_id,
  };
}

export async function snapshot(db: Db): Promise<Snapshot> {
  const q = { shop_id: SHOP_ID };
  const [sign, menu, till, ctl, pendingDocs, idents, items] = await Promise.all(
    [
      db.collection<AnyDoc>("target_sign").find(q).toArray(),
      db.collection<AnyDoc>("target_menu").find(q).toArray(),
      db.collection<AnyDoc>("target_till").find(q).toArray(),
      db.collection<AnyDoc>("control").findOne({ _id: SHOP_ID }),
      actions(db)
        .find(
          { shop_id: SHOP_ID, status: "pending_approval" },
          { sort: { created_at: 1 } },
        )
        .toArray(),
      db
        .collection<Identity>("identities")
        .find({ shop_id: SHOP_ID })
        .toArray(),
      db
        .collection<AnyDoc>("menu_items")
        .find(q, { projection: { name_en: 1 } })
        .toArray(),
    ],
  );
  const nameOf = new Map(idents.map((i) => [i._id, i.name]));
  const itemOf = new Map(items.map((i) => [i._id, i.name_en as string]));
  const sortIt = (arr: AnyDoc[]) =>
    arr.sort((a, b) => byItemOrder(a as any, b as any));
  const pending: PendingApproval[] = pendingDocs.map((a) => ({
    action_id: a._id,
    requested_by: nameOf.get(a.actor.human_id) ?? a.actor.human_id,
    role: a.actor.role,
    summary: summarize(
      a.type,
      a.params,
      itemOf.get(a.params.item_id ?? "") ?? a.params.item_id ?? "item",
    ),
    utterance: a.utterance.text,
    reason: a.policy.reason ?? "",
    created_at: a.created_at.toISOString(),
  }));
  return {
    sign: sortIt(sign).map(signView),
    menu: sortIt(menu).map(signView),
    till: sortIt(till).map(tillView),
    halted: !!ctl?.halt,
    pending,
  };
}

export async function verifyChain(
  db: Db,
): Promise<{ ok: boolean; entries: number; broken_at: number | null }> {
  const cursor = db
    .collection<AnyDoc>("audit")
    .find({ shop_id: SHOP_ID }, { sort: { seq: 1 }, batchSize: 5000 });
  const ctlP = db.collection<AnyDoc>("control").findOne({ _id: SHOP_ID });
  ctlP.catch(() => {});
  let prev = "genesis";
  let expectSeq = 1;
  let entries = 0;
  for await (const e of cursor) {
    entries++;
    if (
      e.seq !== expectSeq ||
      e.prev_hash !== prev ||
      (await entryHash(e)) !== e.hash
    ) {
      return {
        ok: false,
        entries,
        broken_at:
          typeof e.seq === "number" ? Math.min(e.seq, expectSeq) : expectSeq,
      };
    }
    prev = e.hash;
    expectSeq++;
  }
  const ctl = await ctlP;
  if (
    ctl &&
    entries > 0 &&
    (ctl.audit_seq !== entries || ctl.last_hash !== prev)
  ) {
    // the tail was deleted or the counter edited
    return { ok: false, entries, broken_at: entries + 1 };
  }
  return { ok: true, entries, broken_at: null };
}

export async function getRecord(
  db: Db,
  action_id: string | null,
): Promise<RecordView | null> {
  const action = action_id
    ? await actions(db).findOne({ _id: action_id })
    : await actions(db).findOne(
        { shop_id: SHOP_ID },
        { sort: { created_at: -1 } },
      );
  if (!action) return null;
  const [audit, ident, chain, item_name] = await Promise.all([
    db
      .collection<AnyDoc>("audit")
      .find(
        { action_id: action._id },
        { sort: { seq: 1 }, projection: { _id: 0 } },
      )
      .toArray(),
    getIdentity(db, action.actor.human_id),
    verifyChain(db),
    (async () => {
      let item_id = action.params.item_id ?? null;
      if (!item_id && action.undo_of)
        item_id =
          (await actions(db).findOne({ _id: action.undo_of }))?.params
            .item_id ?? null;
      return itemName(db, item_id);
    })(),
  ]);
  return {
    action: toPlain(action),
    audit: audit as AuditEntry[],
    speaker_name: ident?.name ?? action.actor.human_id,
    item_name,
    chain,
  };
}

export async function listActions(
  db: Db,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const docs = await actions(db)
    .find(
      { shop_id: SHOP_ID },
      {
        sort: { created_at: -1 },
        limit: Math.max(1, Math.min(limit || 20, 200)),
      },
    )
    .toArray();
  return docs.map((a) => {
    const { menu_previous, ...rest } = a as AnyDoc;
    return toPlain(rest);
  });
}
