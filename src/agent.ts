import { Agent, type Connection } from "agents";
import { MongoClient, type Db } from "mongodb";
import * as ledger from "./ledger";
import { handleApproval, handleUtterance } from "./orchestrator";
import { AGENT_ID, SHOP_ID, type Env, type RunTrace, type ShopState } from "./types";

const WATCHED = ["target_sign", "target_menu", "target_till", "policies", "control", "actions", "sessions"];

const EMPTY: ShopState = { sign: [], menu: [], till: [], halted: false, pending: [], trace: null, updatedAt: 0 };

/**
 * One agent per shop. It holds the only MongoDB client, keeps a change stream open on Atlas,
 * and pushes a fresh snapshot to every connected screen whenever Atlas changes.
 * Its own storage holds only the change-stream resume token and the cached snapshot;
 * identities, rules, actions, audit and target state live in Atlas.
 */
export class YesChefAgent extends Agent<Env, ShopState> {
  initialState: ShopState = EMPTY;

  #client?: MongoClient;
  #listening = false;

  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`;
    await this.scheduleEvery(30, "ensureStream"); // heartbeat: keeps the object awake and the stream open
    this.ctx.waitUntil(this.listen());
  }

  /** Screens are view-only: only the server sets state. */
  shouldConnectionBeReadonly(_connection: Connection) {
    return true;
  }

  db(): Db {
    this.#client ??= new MongoClient(this.env.MONGODB_URI, {
      maxPoolSize: 8,
      minPoolSize: 5,
      serverSelectionTimeoutMS: 8000,
      ignoreUndefined: true,
    });
    return this.#client.db(this.env.MONGODB_DB);
  }

  /** Drop a client whose topology died so the next call reconnects. */
  async resetClient() {
    const c = this.#client;
    this.#client = undefined;
    try {
      await c?.close();
    } catch {}
  }

  async ensureStream() {
    this.ctx.waitUntil(this.listen());
  }

  /** Change stream on Atlas. Every change to a watched collection redraws every screen. */
  async listen() {
    if (this.#listening) return;
    this.#listening = true;
    try {
      const saved = this.sql<{ v: string }>`SELECT v FROM kv WHERE k = 'resume'`[0];
      const stream = this.db().watch([{ $match: { "ns.coll": { $in: WATCHED } } }], {
        fullDocument: "updateLookup",
        fullDocumentBeforeChange: "whenAvailable",
        ...(saved ? { resumeAfter: JSON.parse(saved.v) } : {}),
      });
      for await (const change of stream) {
        this.sql`INSERT OR REPLACE INTO kv (k, v) VALUES ('resume', ${JSON.stringify(change._id)})`;
        await this.onAtlasChange(change as any);
      }
    } catch (err) {
      console.error("change stream ended", err);
      await this.resetClient();
      this.sql`DELETE FROM kv WHERE k = 'resume'`; // a stale token must not block the next attempt
    } finally {
      this.#listening = false;
    }
  }

  async onAtlasChange(change: any) {
    this.queueRefresh();
    const coll: string = change?.ns?.coll ?? "";
    if (coll.startsWith("target_")) await this.guardTarget(coll, change);
  }

  #expectedReverts = new Set<string>();

  /**
   * Bypass watcher. Every legitimate write to a target carries a new action_id.
   * A change that keeps the same action_id and timestamp but alters what customers see was made
   * outside the agent (for example by hand in Atlas): put the previous state back and record it.
   */
  async guardTarget(coll: string, change: any) {
    const op = change.operationType;
    const before = change.fullDocumentBeforeChange;
    const after = change.fullDocument;
    const key = `${coll}/${String(change.documentKey?._id)}`;
    if (this.#expectedReverts.delete(key)) return; // our own restoring write
    if (!before) return;
    const FIELDS = ["text_en", "text_fr", "price", "sold_out", "promo_en", "promo_fr", "ends_at", "available", "discount_pct"];
    if (op !== "update" && op !== "replace") return; // inserts and deletes are the seed script's reset
    const changed = FIELDS.filter((f) => JSON.stringify(before[f] ?? null) !== JSON.stringify(after?.[f] ?? null));
    if (!changed.length) return;
    // A real write (publish, undo, restore, seed) changes action_id or updated_at. A hand edit changes neither.
    if (after?.action_id !== before.action_id) return;
    if (String(after?.updated_at) !== String(before.updated_at)) return;

    const db = this.db();
    this.#expectedReverts.add(key);
    await db.collection(coll).replaceOne({ _id: before._id }, before, { upsert: true });
    const system = coll.replace("target_", "");
    const detail = {
      target: system,
      item_id: String(before._id),
      fields: changed,
      attempted: Object.fromEntries(changed.map((f) => [f, after?.[f] ?? null])),
      restored: Object.fromEntries(changed.map((f) => [f, before[f] ?? null])),
      last_action_id: before.action_id,
    };
    const actor = { human_id: "unknown", role: "none", agent_id: AGENT_ID } as any;
    await ledger.auditEvent(db, { event: "drift.detected", action_id: before.action_id === "seed" ? null : before.action_id, actor, detail });
    await ledger.auditEvent(db, { event: "drift.reverted", action_id: before.action_id === "seed" ? null : before.action_id, actor, detail });
    this.#emit({
      run_id: `drift_${Date.now().toString(36)}`,
      speaker: "Atlas",
      role: "owner",
      text: `Direct edit to the ${system} (${changed.join(", ")}) with no action behind it`,
      steps: [
        { key: "note", label: `Change stream saw an edit to the ${system} with no action`, status: "blocked", detail: `${String(before._id)} · ${changed.join(", ")}` },
        { key: "target", label: `Restored the ${system} from the database's own before-image`, status: "ok" },
        { key: "note", label: "Recorded drift.detected and drift.reverted in the audit log", status: "info" },
      ],
      say: `Someone changed the ${system} directly, chef. No rule allowed it, so I put it back.`,
      done: true,
    });
    this.ctx.waitUntil(this.anchorHead());
    this.queueRefresh();
  }

  #refreshTimer?: ReturnType<typeof setTimeout>;
  #refreshing = false;
  #dirty = false;

  /** Coalesce bursts of changes into one snapshot read, so a publish does not flood the database. */
  queueRefresh() {
    if (this.#refreshing) {
      this.#dirty = true;
      return;
    }
    if (this.#refreshTimer) return;
    this.#refreshTimer = setTimeout(async () => {
      this.#refreshTimer = undefined;
      this.#refreshing = true;
      try {
        await this.refresh();
      } catch (err) {
        console.error("refresh failed", err);
      } finally {
        this.#refreshing = false;
        if (this.#dirty) {
          this.#dirty = false;
          this.queueRefresh();
        }
      }
    }, 60);
  }

  /** Rebuild the snapshot from Atlas and push it to every screen. */
  async refresh(): Promise<ShopState> {
    const snap = await ledger.snapshot(this.db());
    const next: ShopState = { ...this.state, ...snap, updatedAt: Date.now() };
    this.setState(next);
    return next;
  }

  #emit = (trace: RunTrace) => {
    this.setState({ ...this.state, trace, updatedAt: Date.now() });
  };

  // The agent handles one command at a time. Two changes arriving together (someone speaking while
  // the owner taps Approve) run one after the other, so neither sees a half-written target.
  // The stop switch and the owner check-in do not wait in this queue: a stop must land mid-run.
  #queue: Promise<unknown> = Promise.resolve();
  #inOrder<T>(job: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(job, job);
    this.#queue = run.catch(() => {});
    return run;
  }

  /** One spoken or typed sentence. */
  async utterance(input: { human_id: string; text: string; stt: "elevenlabs" | "typed" }) {
    return this.#inOrder(async () => {
      const out = await handleUtterance(this.db(), await this.#runEnv(), input, this.#emit);
      this.ctx.waitUntil(this.anchorHead());
      await this.refresh();
      return out;
    });
  }

  /** The owner's answer to a held request. */
  async approve(input: { action_id: string; approve: boolean }) {
    return this.#inOrder(async () => {
      const out = await handleApproval(this.db(), await this.#runEnv(), { ...input, approver_id: "usr_marie" }, this.#emit);
      this.ctx.waitUntil(this.anchorHead());
      await this.refresh();
      return out;
    });
  }

  /**
   * Owner check-in, called only from the owner's own device (owner key).
   * It opens or closes a time-limited owner session stored in Atlas; a TTL index removes it when it expires.
   */
  async session(input: { open: boolean; minutes?: number }) {
    const db = this.db();
    if (input.open) {
      const minutes = Math.min(Math.max(Number(input.minutes ?? 10), 0.25), 60);
      const s = await ledger.openOwnerSession(db, { human_id: "usr_marie", minutes });
      await this.schedule(new Date(new Date(s.expires_at).getTime() + 500), "refresh"); // redraw when it lapses
    } else {
      await ledger.closeOwnerSession(db, "usr_marie");
    }
    this.ctx.waitUntil(this.anchorHead());
    const state = await this.refresh();
    return { owner_session: state.owner_session ?? null };
  }

  /** Kill switch. Stored in Atlas, read before every target write. */
  async halt(input: { halt: boolean; human_id?: string }) {
    const who = (await ledger.getIdentity(this.db(), input.human_id ?? "usr_marie")) ?? null;
    await ledger.setHalt(this.db(), !!input.halt, {
      human_id: who?._id ?? "usr_marie",
      role: (who?.role as any) ?? "owner",
      agent_id: AGENT_ID,
    });
    this.ctx.waitUntil(this.anchorHead());
    await this.refresh();
    return { halt: !!input.halt };
  }

  async record(action_id: string | null) {
    const [rec, anchor] = await Promise.all([ledger.getRecord(this.db(), action_id), this.checkAnchor()]);
    return rec ? { ...rec, chain: { ...rec.chain, anchor } } : rec;
  }

  async actions(limit: number) {
    return ledger.listActions(this.db(), limit);
  }

  async chain() {
    const [check, anchor] = await Promise.all([ledger.verifyChain(this.db()), this.checkAnchor()]);
    return { ...check, anchor };
  }

  // ---- Anchor: the head of the audit chain, remembered outside Atlas ----
  // A hash chain shows an edited entry, but someone who controls the database could rewrite or
  // truncate the whole chain consistently. The agent therefore keeps the last head it saw
  // (sequence number and hash) in its own storage, and the check compares Atlas against it.

  #readAnchor(): { seq: number; hash: string; at: string } | null {
    const row = this.sql<{ v: string }>`SELECT v FROM kv WHERE k = 'anchor'`[0];
    return row?.v ? JSON.parse(row.v) : null;
  }

  /** Does the entry the anchor points at still exist in Atlas with the same hash? */
  async checkAnchor() {
    const a = this.#readAnchor();
    if (!a) return null;
    if (a.seq === 0) return { seq: 0, hash: a.hash, at: a.at, matches: true };
    const entry = await this.db()
      .collection("audit")
      .findOne({ shop_id: SHOP_ID, seq: a.seq }, { projection: { hash: 1 } });
    return { seq: a.seq, hash: a.hash.slice(0, 12), at: a.at, matches: !!entry && entry.hash === a.hash };
  }

  /** Move the anchor to the current head, but only if history up to the old anchor is unchanged. */
  async anchorHead(force = false) {
    try {
      const db = this.db();
      if (!force) {
        const current = await this.checkAnchor();
        if (current && !current.matches) return; // keep the old anchor so the mismatch stays visible
      }
      const control = await db.collection("control").findOne({ _id: SHOP_ID } as any);
      if (!control) return;
      const next = { seq: control.audit_seq ?? 0, hash: control.last_hash ?? "genesis", at: new Date().toISOString() };
      this.sql`INSERT OR REPLACE INTO kv (k, v) VALUES ('anchor', ${JSON.stringify(next)})`;
    } catch (err) {
      console.error("anchor failed", err);
    }
  }

  /**
   * Demo settings that are not shop data, so they live in the agent's own storage:
   * where phones can reach this shop (a tunnel to the laptop), and slow mode
   * (a pause between targets so the kill switch can be shown mid-run).
   */
  async config(input?: { public_url?: string | null; slow?: boolean; reanchor?: boolean }) {
    if (input?.reanchor) await this.anchorHead(true);
    if (input && "public_url" in input) {
      const v = (input.public_url ?? "").replace(/\/$/, "");
      this.sql`INSERT OR REPLACE INTO kv (k, v) VALUES ('public_url', ${v})`;
    }
    if (input && "slow" in input) {
      this.sql`INSERT OR REPLACE INTO kv (k, v) VALUES ('slow', ${input.slow ? "1" : "0"})`;
    }
    const rows = this.sql<{ k: string; v: string }>`SELECT k, v FROM kv WHERE k IN ('public_url', 'slow')`;
    const get = (k: string) => rows.find((r) => r.k === k)?.v ?? "";
    return { public_url: get("public_url") || null, slow: get("slow") === "1" };
  }

  /** Env plus the runtime demo settings the orchestrator reads. */
  async #runEnv() {
    const cfg = await this.config();
    return { ...this.env, slowMs: cfg.slow ? 2500 : 0 } as Env;
  }

  /** Connectivity check used by /api/health. */
  async health() {
    const t0 = Date.now();
    try {
      const ping = await this.db().command({ ping: 1 });
      return { ok: ping.ok === 1, db: this.env.MONGODB_DB, ms: Date.now() - t0, listening: this.#listening };
    } catch (err: any) {
      await this.resetClient();
      return { ok: false, error: String(err?.message ?? err), name: err?.name, ms: Date.now() - t0 };
    }
  }
}
