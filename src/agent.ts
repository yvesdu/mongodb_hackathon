import { Agent, type Connection } from "agents";
import { MongoClient, type Db } from "mongodb";
import * as ledger from "./ledger";
import { handleApproval, handleUtterance } from "./orchestrator";
import { AGENT_ID, type Env, type RunTrace, type ShopState } from "./types";

const WATCHED = ["target_sign", "target_menu", "target_till", "policies", "control", "actions"];

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
      maxPoolSize: 5,
      minPoolSize: 0,
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

  async onAtlasChange(_change: { ns: { coll: string }; operationType: string }) {
    await this.refresh();
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

  /** One spoken or typed sentence. */
  async utterance(input: { human_id: string; text: string; stt: "elevenlabs" | "typed" }) {
    const out = await handleUtterance(this.db(), this.env, input, this.#emit);
    await this.refresh();
    return out;
  }

  /** The owner's answer to a held request. */
  async approve(input: { action_id: string; approve: boolean }) {
    const out = await handleApproval(this.db(), this.env, { ...input, approver_id: "usr_marie" }, this.#emit);
    await this.refresh();
    return out;
  }

  /** Kill switch. Stored in Atlas, read before every target write. */
  async halt(input: { halt: boolean; human_id?: string }) {
    const who = (await ledger.getIdentity(this.db(), input.human_id ?? "usr_marie")) ?? null;
    await ledger.setHalt(this.db(), !!input.halt, {
      human_id: who?._id ?? "usr_marie",
      role: (who?.role as any) ?? "owner",
      agent_id: AGENT_ID,
    });
    await this.refresh();
    return { halt: !!input.halt };
  }

  async record(action_id: string | null) {
    return ledger.getRecord(this.db(), action_id);
  }

  async actions(limit: number) {
    return ledger.listActions(this.db(), limit);
  }

  async chain() {
    return ledger.verifyChain(this.db());
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
