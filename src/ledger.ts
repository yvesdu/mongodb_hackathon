// Yes Chef ledger: every read and write against Atlas. Runs in Node and in a Cloudflare
// Worker / Durable Object: uses only the `mongodb` driver and Web Crypto.
import type { ClientSession, Db } from "mongodb";
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

/** Append one audit entry inside the given session: reads control, inserts the entry, advances control. */
async function appendAudit(
  db: Db,
  session: ClientSession,
  e: AuditInput,
): Promise<AuditEntry> {
  const control = db.collection<AnyDoc>("control");
  const ctl = await control.findOne({ _id: SHOP_ID }, { session });
  const prevSeq: number = ctl?.audit_seq ?? 0;
  const prevHash: string = ctl?.last_hash ?? "genesis";
  const entry: AnyDoc = clean({
    shop_id: SHOP_ID,
    seq: prevSeq + 1,
    ts: new Date().toISOString(),
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
  await db.collection<AnyDoc>("audit").insertOne(entry, { session });
  const r = await control.updateOne(
    { _id: SHOP_ID, audit_seq: prevSeq },
    { $set: { audit_seq: entry.seq, last_hash: entry.hash } },
    { session, upsert: !ctl },
  );
  if (!ctl ? false : r.matchedCount !== 1)
    throw new Error("audit counter moved; retry");
  delete entry._id;
  return entry as AuditEntry;
}

const actions = (db: Db) => db.collection<ActionDoc>("actions");

async function getAction(
  db: Db,
  id: string,
  session?: ClientSession,
): Promise<ActionDoc> {
  const a = await actions(db).findOne({ _id: id }, { session });
  if (!a) throw new Error(`action ${id} not found`);
  return a;
}

/**
 * One state step: filtered action update + audit insert + control update in one transaction.
 * Throws if the action is not in one of the expected statuses.
 */
async function step(
  db: Db,
  action_id: string,
  expected: ActionStatus | ActionStatus[],
  set: AnyDoc,
  audit: Omit<AuditInput, "action_id"> | null,
  extra?: (s: ClientSession) => Promise<void>,
): Promise<ActionDoc> {
  const exp = Array.isArray(expected) ? expected : [expected];
  return inTxn(db, async (session) => {
    const r = await actions(db).updateOne(
      { _id: action_id, status: { $in: exp } },
      { $set: clean({ ...set, updated_at: new Date() }) },
      { session },
    );
    if (r.matchedCount !== 1) {
      const cur = await actions(db).findOne({ _id: action_id }, { session });
      throw new Error(
        `action ${action_id} is ${cur?.status ?? "missing"}, expected ${exp.join("|")}`,
      );
    }
    if (audit) {
      const cur = await getAction(db, action_id, session);
      await appendAudit(db, session, {
        ...audit,
        action_id,
        run_id: audit.run_id ?? cur.run_id,
      });
    }
    if (extra) await extra(session);
    return getAction(db, action_id, session);
  });
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
  const c = await db.collection<AnyDoc>("control").findOne({ _id: SHOP_ID });
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
  await inTxn(db, async (session) => {
    await db
      .collection<AnyDoc>("control")
      .updateOne({ _id: SHOP_ID }, { $set: { halt } }, { session });
    await appendAudit(db, session, {
      event: halt ? "halt.set" : "halt.cleared",
      actor,
      detail: { halt },
    });
  });
}

export async function auditEvent(db: Db, e: AuditInput): Promise<void> {
  await inTxn(db, (session) => appendAudit(db, session, e));
}

export async function proposeAction(
  db: Db,
  input: {
    run_id: string;
    type: ActionType;
    actor: Actor;
    utterance: ActionDoc["utterance"];
    evidence: Evidence[];
    params: ActionParams;
    undo_of?: string | null;
  },
): Promise<ActionDoc> {
  const now = new Date();
  const ident = await getIdentity(db, input.actor.human_id);
  const doc: ActionDoc = clean({
    _id: newId("act"),
    shop_id: SHOP_ID,
    run_id: input.run_id,
    type: input.type,
    status: "proposed",
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
    policy: { decision: "pending", rule_id: null, version: null, reason: null },
    targets: ORDER.map((name) => ({ name, status: "pending", previous: null })),
    undo_of: input.undo_of ?? null,
    created_at: now,
    updated_at: now,
  } as ActionDoc);
  await inTxn(db, async (session) => {
    await actions(db).insertOne(doc, { session });
    await appendAudit(db, session, {
      event: "action.proposed",
      action_id: doc._id,
      run_id: doc.run_id,
      actor: doc.actor,
      detail: clean({
        type: doc.type,
        params: doc.params,
        utterance: doc.utterance.text,
        speaker_name: ident?.name ?? doc.actor.human_id,
        undo_of: doc.undo_of,
      }),
    });
  });
  return doc;
}

export async function recordDecision(
  db: Db,
  action_id: string,
  decision: PolicyDecision,
): Promise<ActionDoc> {
  const status: ActionStatus =
    decision.decision === "allow"
      ? "allowed"
      : decision.decision === "needs_approval"
        ? "pending_approval"
        : "blocked";
  const event =
    status === "allowed"
      ? "policy.allowed"
      : status === "pending_approval"
        ? "policy.held"
        : "policy.blocked";
  const a = await getAction(db, action_id);
  const policy = clean({
    decision: decision.decision === "pending" ? "deny" : decision.decision,
    rule_id: decision.rule_id ?? null,
    version: decision.version ?? null,
    reason: decision.reason ?? null,
  });
  return step(
    db,
    action_id,
    "proposed",
    { status, policy },
    {
      event,
      actor: a.actor,
      detail: {
        decision: policy.decision,
        rule_id: policy.rule_id,
        version: policy.version,
        reason: policy.reason,
      },
    },
  );
}

export async function resolveApproval(
  db: Db,
  action_id: string,
  input: { approve: boolean; approver: { human_id: string; role: string } },
): Promise<ActionDoc> {
  const a = await getAction(db, action_id);
  const ident = await getIdentity(db, input.approver.human_id);
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
      action_id,
      "pending_approval",
      {
        status: "allowed",
        "policy.decision": "allow",
        "policy.approved_by": input.approver.human_id,
        "policy.approved_at": at,
      },
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
    );
  }
  return step(
    db,
    action_id,
    "pending_approval",
    { status: "rejected" },
    {
      event: "approval.denied",
      actor,
      detail: {
        approver_name,
        rule_id: a.policy.rule_id,
        version: a.policy.version,
      },
    },
  );
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

async function setTarget(
  db: Db,
  action_id: string,
  idx: number,
  fields: AnyDoc,
  audit: Omit<AuditInput, "action_id"> | null,
  expected: ActionStatus[] = ["applying", "applied"],
): Promise<ActionDoc> {
  const set: AnyDoc = {};
  for (const [k, v] of Object.entries(fields)) set[`targets.${idx}.${k}`] = v;
  return step(db, action_id, expected, set, audit);
}

interface PublishOpts {
  slowMs?: number;
  onStep?: (s: TraceStep) => void | Promise<void>;
}

export async function publish(
  db: Db,
  action_id: string,
  opts: PublishOpts = {},
): Promise<ActionDoc> {
  let a = await getAction(db, action_id);
  if (a.type === "undo") return publishUndo(db, a, opts);
  const item_id = a.params.item_id;
  if (!item_id) throw new Error(`action ${action_id} has no item_id`);
  const sys = agentActor();

  a = await step(
    db,
    action_id,
    "allowed",
    { status: "applying" },
    {
      event: "action.applying",
      actor: a.actor,
      detail: { type: a.type, item_id },
    },
  );

  const intended: Partial<Record<TargetName, AnyDoc>> = {};
  for (let i = 0; i < ORDER.length; i++) {
    const name = ORDER[i];
    if (await isHalted(db)) return compensate(db, action_id, "halted", opts);
    const coll = db.collection<AnyDoc>(COLL[name]);
    const current = await coll.findOne({ _id: item_id });
    const changes = changesFor(a.type, a.params, name);
    intended[name] = changes;
    if (
      current &&
      current.action_id === action_id &&
      sameFields(current, changes)
    ) {
      // already written by an earlier attempt: skip
    } else {
      await setTarget(
        db,
        action_id,
        i,
        { status: "pending", previous: current ?? null },
        null,
        ["applying"],
      );
      try {
        const r = await coll.updateOne(
          { _id: item_id },
          { $set: { ...changes, action_id, updated_at: new Date() } },
        );
        if (r.matchedCount !== 1)
          throw new Error(`${name} has no document for ${item_id}`);
      } catch (err) {
        await opts.onStep?.({
          key: "target",
          label: `${TARGET_LABEL[name]} write failed`,
          status: "fail",
          detail: errText(err),
        });
        return compensate(db, action_id, "failed", opts, errText(err));
      }
    }
    await setTarget(
      db,
      action_id,
      i,
      { status: "applied", applied_at: new Date() },
      {
        event: "target.applied",
        actor: sys,
        detail: { target: name, item_id, changes },
      },
      ["applying"],
    );
    await opts.onStep?.({
      key: "target",
      label: `${TARGET_LABEL[name]} updated`,
      status: "ok",
      detail: describeChanges(changes),
    });
    if (opts.slowMs) await sleep(opts.slowMs);
  }

  await step(
    db,
    action_id,
    "applying",
    { status: "applied" },
    {
      event: "action.applied",
      actor: sys,
      detail: { targets: ORDER },
    },
  );

  for (let i = 0; i < ORDER.length; i++) {
    const name = ORDER[i];
    const now = await db
      .collection<AnyDoc>(COLL[name])
      .findOne({ _id: item_id });
    if (
      !now ||
      now.action_id !== action_id ||
      !sameFields(now, intended[name]!)
    ) {
      await opts.onStep?.({
        key: "verified",
        label: `${TARGET_LABEL[name]} read-back mismatch`,
        status: "fail",
      });
      return compensate(
        db,
        action_id,
        "failed",
        opts,
        `${name} read-back mismatch`,
      );
    }
    await setTarget(
      db,
      action_id,
      i,
      { status: "verified", verified_at: new Date() },
      {
        event: "target.verified",
        actor: sys,
        detail: { target: name, item_id },
      },
      ["applied"],
    );
  }

  // Commit intent: menu_items, then the action is verified.
  const menuColl = db.collection<AnyDoc>("menu_items");
  const before = await menuColl.findOne({ _id: item_id });
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
  const done = await step(
    db,
    action_id,
    "applied",
    { status: "verified", menu_previous: before ?? null },
    {
      event: "action.verified",
      actor: sys,
      detail: { item_id, menu: menuSet },
    },
    async (session) => {
      await menuColl.updateOne(
        { _id: item_id },
        { $set: clean(menuSet) },
        { session },
      );
    },
  );
  await opts.onStep?.({
    key: "verified",
    label: "Read back on sign, menu and till",
    status: "ok",
  });
  return done;
}

/** Restore every applied target from `previous`, in reverse order, then finish as halted or failed. */
async function compensate(
  db: Db,
  action_id: string,
  final: "halted" | "failed",
  opts: PublishOpts,
  why?: string,
): Promise<ActionDoc> {
  const a = await getAction(db, action_id);
  const sys = agentActor();
  for (let i = a.targets.length - 1; i >= 0; i--) {
    const t = a.targets[i];
    if (
      t.status !== "applied" &&
      t.status !== "verified" &&
      !(t.status === "pending" && t.previous)
    )
      continue;
    const item_id = a.params.item_id!;
    const coll = db.collection<AnyDoc>(COLL[t.name]);
    if (t.status === "pending") {
      // previous was saved but the write may or may not have landed: restore only if it did
      const cur = await coll.findOne({ _id: item_id });
      if (!cur || cur.action_id !== action_id) continue;
    }
    if (t.previous) await coll.replaceOne({ _id: item_id }, clean(t.previous));
    await setTarget(
      db,
      action_id,
      i,
      { status: "reverted" },
      {
        event: "target.reverted",
        actor: sys,
        detail: {
          target: t.name,
          item_id,
          restored_action_id: (t.previous as AnyDoc | null)?.action_id ?? null,
        },
      },
      ["applying", "applied"],
    );
    await opts.onStep?.({
      key: "target",
      label: `${TARGET_LABEL[t.name]} restored`,
      status: "info",
    });
  }
  const done = await step(
    db,
    action_id,
    ["applying", "applied"],
    { status: final },
    {
      event: `action.${final}`,
      actor: sys,
      detail: why ? { reason: why } : {},
    },
  );
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

  await step(
    db,
    action_id,
    "allowed",
    { status: "applying", "params.item_id": item_id },
    {
      event: "action.applying",
      actor: u.actor,
      detail: { type: "undo", undo_of: orig._id, item_id },
    },
  );

  const restored: Partial<Record<TargetName, AnyDoc>> = {};
  for (let i = ORDER.length - 1; i >= 0; i--) {
    const name = ORDER[i];
    if (await isHalted(db)) return compensate(db, action_id, "halted", opts);
    const prevOrig = orig.targets.find((t) => t.name === name)
      ?.previous as AnyDoc | null;
    if (!prevOrig) continue;
    const coll = db.collection<AnyDoc>(COLL[name]);
    const current = await coll.findOne({ _id: item_id });
    await setTarget(
      db,
      action_id,
      i,
      { status: "pending", previous: current ?? null },
      null,
      ["applying"],
    );
    const doc = clean({ ...prevOrig, action_id, updated_at: new Date() });
    restored[name] = contentOf(doc);
    try {
      await coll.replaceOne({ _id: item_id }, doc);
    } catch (err) {
      return compensate(db, action_id, "failed", opts, errText(err));
    }
    await setTarget(
      db,
      action_id,
      i,
      { status: "applied", applied_at: new Date() },
      {
        event: "target.applied",
        actor: sys,
        detail: { target: name, item_id, restored_from: orig._id },
      },
      ["applying"],
    );
    await opts.onStep?.({
      key: "target",
      label: `${TARGET_LABEL[name]} restored`,
      status: "ok",
    });
    if (opts.slowMs) await sleep(opts.slowMs);
  }

  await step(
    db,
    action_id,
    "applying",
    { status: "applied" },
    { event: "action.applied", actor: sys, detail: {} },
  );

  for (let i = ORDER.length - 1; i >= 0; i--) {
    const name = ORDER[i];
    if (!restored[name]) continue;
    const now = await db
      .collection<AnyDoc>(COLL[name])
      .findOne({ _id: item_id });
    if (
      !now ||
      now.action_id !== action_id ||
      !sameFields(now, restored[name]!)
    ) {
      return compensate(
        db,
        action_id,
        "failed",
        opts,
        `${name} read-back mismatch`,
      );
    }
    await setTarget(
      db,
      action_id,
      i,
      { status: "verified", verified_at: new Date() },
      {
        event: "target.verified",
        actor: sys,
        detail: { target: name, item_id },
      },
      ["applied"],
    );
  }

  const menuColl = db.collection<AnyDoc>("menu_items");
  const menuPrev = (orig as AnyDoc).menu_previous as AnyDoc | null;
  const done = await step(
    db,
    action_id,
    "applied",
    { status: "verified" },
    {
      event: "action.verified",
      actor: sys,
      detail: { item_id, undo_of: orig._id },
    },
    async (session) => {
      if (menuPrev) {
        await menuColl.replaceOne(
          { _id: item_id },
          clean({ ...menuPrev, last_action_id: action_id }),
          { session },
        );
      }
      const r = await actions(db).updateOne(
        { _id: orig._id, status: "verified" },
        {
          $set: {
            status: "rolled_back",
            rolled_back_by: action_id,
            updated_at: new Date(),
          },
        },
        { session },
      );
      if (r.matchedCount !== 1)
        throw new Error(`original ${orig._id} is no longer verified`);
      await appendAudit(db, session, {
        event: "action.rolled_back",
        action_id: orig._id,
        run_id: orig.run_id,
        actor: u.actor,
        detail: { undo_action_id: action_id },
      });
    },
  );
  await opts.onStep?.({
    key: "verified",
    label: "Undo read back on sign, menu and till",
    status: "ok",
  });
  return done;
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

  const audit = await db
    .collection<AuditEntry>("audit")
    .find({ action_id: action._id }, { sort: { seq: 1 } })
    .toArray();
  const ev = (name: string) => audit.find((e) => e.event === name);
  const proposed = ev("action.proposed");
  const speaker = String(
    proposed?.detail?.speaker_name ?? action.actor.human_id,
  );

  let original: ActionDoc | null = null;
  if (action.type === "undo" && action.undo_of)
    original = await actions(db).findOne({ _id: action.undo_of });
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
    .find({ shop_id: SHOP_ID }, { sort: { seq: 1 } });
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
  const ctl = await db.collection<AnyDoc>("control").findOne({ _id: SHOP_ID });
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
  const [audit, ident, chain] = await Promise.all([
    db
      .collection<AnyDoc>("audit")
      .find(
        { action_id: action._id },
        { sort: { seq: 1 }, projection: { _id: 0 } },
      )
      .toArray(),
    getIdentity(db, action.actor.human_id),
    verifyChain(db),
  ]);
  let item_id = action.params.item_id ?? null;
  if (!item_id && action.undo_of)
    item_id =
      (await actions(db).findOne({ _id: action.undo_of }))?.params.item_id ??
      null;
  return {
    action: toPlain(action),
    audit: audit as AuditEntry[],
    speaker_name: ident?.name ?? action.actor.human_id,
    item_name: await itemName(db, item_id),
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
