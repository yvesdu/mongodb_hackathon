// End-to-end check of src/ledger.ts against a real Atlas database (default yeschef_dev).
// Run: npx tsx --env-file=.env scripts/ledger-check.ts
import { MongoClient, type Db } from "mongodb";
import { seed } from "./seed.ts";
import * as L from "../src/ledger.ts";
import { AGENT_ID, type Actor } from "../src/types.ts";

const DB = process.env.LEDGER_CHECK_DB || "yeschef_dev";
if (DB === "yeschef")
  throw new Error("ledger-check refuses to run against the live database");

const marie: Actor = {
  human_id: "usr_marie",
  role: "owner",
  agent_id: AGENT_ID,
};
const sam: Actor = {
  human_id: "usr_sam",
  role: "employee",
  agent_id: AGENT_ID,
};
let failures = 0;

function check(name: string, ok: boolean, info = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? `  (${info})` : ""}`);
}

async function targets(db: Db, item: string) {
  const [sign, menu, till] = await Promise.all(
    ["target_sign", "target_menu", "target_till"].map((c) =>
      db.collection<any>(c).findOne({ _id: item }),
    ),
  );
  return { sign, menu, till };
}

const strip = (d: any) => {
  if (!d) return d;
  const { updated_at, action_id, ...rest } = d;
  return JSON.stringify(rest);
};

async function propose(
  db: Db,
  actor: Actor,
  type: any,
  params: any,
  text: string,
  undo_of: string | null = null,
) {
  return L.proposeAction(db, {
    run_id: `run_check_${Date.now()}`,
    type,
    actor,
    utterance: { text, lang: "en", stt: "typed" },
    evidence: [],
    params,
    undo_of,
  });
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI missing");
  const client = new MongoClient(uri);
  const db = client.db(DB);
  try {
    await seed(db, true, () => {});
    check(
      "reset and seed",
      (await L.loadMenu(db)).length === 4 &&
        (await L.loadRules(db)).length === 6,
    );

    // 1. owner promo: propose, allow, publish
    const before = await targets(db, "item_coffee");
    const steps: string[] = [];
    const t0 = Date.now();
    let a = await L.proposeDecided(db, {
      run_id: `run_check_${Date.now()}`,
      type: "start_promo",
      actor: marie,
      utterance: { text: "Two-for-one coffee until noon", lang: "en", stt: "typed" },
      evidence: [],
      params: {
        item_id: "item_coffee",
        discount_pct: 50,
        text_en: "2 for 1 until noon",
        text_fr: "2 pour 1 jusqu'à midi",
        ends_at: "12:00",
      },
      decision: {
        decision: "allow",
        rule_id: "owner_promos",
        version: 1,
        reason: "Owners may run promos up to 50% off.",
      },      begin: true,
    });
    check("proposeDecided with begin -> applying", a.status === "applying" && a.targets.every((t) => t.previous !== null), `status=${a.status}`);
    const tPropose = Date.now() - t0;
    a = await L.publish(db, a._id, {
      onStep: (s) => {
        steps.push(s.label);
      },
    });
    console.log(`TIME  propose+decide+publish of one promo: ${Date.now() - t0} ms (proposeDecided ${tPropose} ms)`);
    const after = await targets(db, "item_coffee");
    check(
      "promo published and verified",
      a.status === "verified" &&
        a.targets.every((t) => t.status === "verified"),
      `status=${a.status}`,
    );
    check(
      "promo changed sign, menu and till",
      after.sign.promo_en === "2 for 1 until noon" &&
        after.menu.promo_fr === "2 pour 1 jusqu'à midi" &&
        after.till.discount_pct === 50 &&
        after.till.price === 3.5 &&
        [after.sign, after.menu, after.till].every(
          (d) => d.action_id === a._id,
        ),
    );
    const menuItem = (await L.loadMenu(db)).find(
      (m) => m._id === "item_coffee",
    );
    check(
      "menu_items promo recorded",
      menuItem?.promo?.discount_pct === 50 &&
        menuItem?.last_action_id === a._id,
    );
    check("onStep called per target", steps.length >= 3, steps.join(" | "));
    const ex1 = await L.explain(db, "item_coffee");
    check(
      "explain promo",
      ex1.action_id === a._id && /50 percent off/.test(ex1.text),
      ex1.text,
    );

    // 2. undo restores all three
    const last = await L.findLastUndoable(db);
    check("findLastUndoable", last?._id === a._id);
    let u = await propose(db, marie, "undo", {}, "Undo that", a._id);
    u = await L.recordDecision(db, u._id, {
      decision: "allow",
      rule_id: "undo_any",
      version: 1,
      reason: null,
    });
    u = await L.publish(db, u._id);
    const restored = await targets(db, "item_coffee");
    const orig = await L.getRecord(db, a._id);
    check(
      "undo verified, original rolled_back",
      u.status === "verified" && orig?.action.status === "rolled_back",
      `undo=${u.status} orig=${orig?.action.status}`,
    );
    check(
      "undo restored sign, menu and till",
      strip(restored.sign) === strip(before.sign) &&
        strip(restored.menu) === strip(before.menu) &&
        strip(restored.till) === strip(before.till),
    );
    const mi2 = (await L.loadMenu(db)).find((m) => m._id === "item_coffee");
    check("undo restored menu_items", mi2?.promo === null);
    const ex2 = await L.explain(db, "item_coffee");
    check("explain undo", ex2.action_id === u._id, ex2.text);

    // 3. held, approved, published
    let h = await propose(
      db,
      sam,
      "start_promo",
      {
        item_id: "item_muffin",
        discount_pct: 20,
        text_en: "20% off",
        text_fr: "20 % de rabais",
        ends_at: null,
      },
      "Twenty percent off muffins",
    );
    h = await L.recordDecision(db, h._id, {
      decision: "needs_approval",
      rule_id: "staff_promos",
      version: 1,
      reason: "Employees may run promos up to 10% off.",
    });
    const snap = await L.snapshot(db);
    check(
      "held action pending in snapshot",
      h.status === "pending_approval" &&
        snap.pending.some(
          (p) =>
            p.action_id === h._id &&
            p.summary === "20% off Muffin" &&
            p.requested_by === "Sam",
        ),
      JSON.stringify(snap.pending.map((p) => p.summary)),
    );
    let blockedPublish = false;
    try {
      await L.publish(db, h._id);
    } catch {
      blockedPublish = true;
    }
    check("held action cannot publish before approval", blockedPublish);
    h = await L.resolveApproval(db, h._id, {
      approve: true,
      approver: { human_id: "usr_marie", role: "owner" },
    });
    check(
      "approval -> allowed with rule and approver",
      h.status === "allowed" &&
        h.policy.decision === "allow" &&
        h.policy.approved_by === "usr_marie" &&
        h.policy.rule_id === "staff_promos",
    );
    h = await L.publish(db, h._id);
    const muf = await targets(db, "item_muffin");
    check(
      "approved action published",
      h.status === "verified" &&
        muf.till.discount_pct === 20 &&
        muf.sign.action_id === h._id,
    );
    const ex3 = await L.explain(db, "item_muffin");
    check(
      "explain held+approved",
      /held/.test(ex3.text) &&
        /Marie approved/.test(ex3.text) &&
        /Sam/.test(ex3.text),
      ex3.text,
    );
    let r = await propose(
      db,
      sam,
      "start_promo",
      {
        item_id: "item_latte",
        discount_pct: 30,
        text_en: "30% off",
        text_fr: "30 % de rabais",
      },
      "30 off lattes",
    );
    r = await L.recordDecision(db, r._id, {
      decision: "needs_approval",
      rule_id: "staff_promos",
      version: 1,
      reason: "Employees may run promos up to 10% off.",
    });
    r = await L.resolveApproval(db, r._id, {
      approve: false,
      approver: { human_id: "usr_marie", role: "owner" },
    });
    check("rejection -> rejected", r.status === "rejected");

    // 4. blocked action leaves targets unchanged
    const latBefore = await targets(db, "item_latte");
    let b = await propose(
      db,
      sam,
      "set_price",
      { item_id: "item_latte", price: 0.1 },
      "Lattes are ten cents",
    );
    b = await L.recordDecision(db, b._id, {
      decision: "deny",
      rule_id: null,
      version: null,
      reason: "No rule lets employees change prices.",
    });
    let refused = false;
    try {
      await L.publish(db, b._id);
    } catch {
      refused = true;
    }
    const latAfter = await targets(db, "item_latte");
    check(
      "blocked action: status blocked, publish refused, targets unchanged",
      b.status === "blocked" &&
        refused &&
        JSON.stringify(latAfter) === JSON.stringify(latBefore),
    );

    // 5. halt mid-publish
    const crBefore = await targets(db, "item_croissant");
    let k = await propose(
      db,
      marie,
      "set_price",
      { item_id: "item_croissant", price: 3.75 },
      "Croissants are 3.75",
    );
    k = await L.recordDecision(db, k._id, {
      decision: "allow",
      rule_id: "owner_prices",
      version: 1,
      reason: null,
    });
    let first = true;
    const kSteps: string[] = [];
    k = await L.publish(db, k._id, {
      slowMs: 300,
      onStep: async (s) => {
        kSteps.push(s.label);
        if (first) {
          first = false;
          await L.setHalt(db, true, marie);
        }
      },
    });
    const crAfter = await targets(db, "item_croissant");
    check(
      "halt mid-publish -> halted",
      k.status === "halted",
      `status=${k.status}; ${kSteps.join(" | ")}`,
    );
    check(
      "halt left nothing half-published",
      strip(crAfter.sign) === strip(crBefore.sign) &&
        strip(crAfter.menu) === strip(crBefore.menu) &&
        strip(crAfter.till) === strip(crBefore.till) &&
        crAfter.sign.action_id === "seed",
      `sign.price=${crAfter.sign.price} till.price=${crAfter.till.price}`,
    );
    check("isHalted reads true", await L.isHalted(db));
    await L.setHalt(db, false, marie);
    check("halt cleared", !(await L.isHalted(db)));

    // 6. hash chain
    const c1 = await L.verifyChain(db);
    check("verifyChain ok", c1.ok && c1.entries > 20, `entries=${c1.entries}`);
    const rec = await L.getRecord(db, null);
    check(
      "getRecord latest",
      !!rec &&
        rec.audit.length > 0 &&
        rec.chain.ok &&
        rec.speaker_name === "Marie",
      `${rec?.action._id} ${rec?.speaker_name} ${rec?.item_name}`,
    );
    const list = await L.listActions(db, 5);
    check(
      "listActions",
      list.length === 5 && typeof list[0].created_at === "string",
    );
    await db
      .collection("audit")
      .updateOne({ seq: 7 }, { $set: { "detail.tampered": true } });
    const c2 = await L.verifyChain(db);
    check(
      "tampered audit entry detected",
      !c2.ok && c2.broken_at === 7,
      `broken_at=${c2.broken_at}`,
    );

    // 7. database refuses an allowed action with no rule
    try {
      await db.collection<any>("actions").insertOne({
        _id: "act_bad",
        shop_id: "shop_demo",
        run_id: "run_bad",
        type: "set_price",
        status: "allowed",
        actor: sam,
        utterance: { text: "x", lang: "en" },
        policy: { decision: "allow", rule_id: null, version: null },
        targets: [],
        created_at: new Date(),
      });
      check(
        "DB rejects allowed action without rule",
        false,
        "insert succeeded",
      );
    } catch (e: any) {
      check(
        "DB rejects allowed action without rule",
        e.code === 121,
        `code=${e.code} ${JSON.stringify(e.errInfo?.details).slice(0, 300)}`,
      );
    }
    try {
      await db.collection<any>("actions").insertOne({
        _id: "act_bad2",
        shop_id: "shop_demo",
        run_id: "run_bad",
        type: "set_price",
        status: "verified",
        actor: sam,
        utterance: { text: "x", lang: "en" },
        policy: { decision: "deny", rule_id: "x", version: 1 },
        targets: [],
        created_at: new Date(),
      });
      check(
        "DB rejects verified action that was denied",
        false,
        "insert succeeded",
      );
    } catch (e: any) {
      check(
        "DB rejects verified action that was denied",
        e.code === 121,
        `code=${e.code}`,
      );
    }

    // 8. sign without French text
    try {
      await db
        .collection("target_sign")
        .updateOne({ _id: "item_latte" as any }, { $set: { text_fr: "   " } });
      check("DB rejects sign with blank text_fr", false, "update succeeded");
    } catch (e: any) {
      const d = JSON.stringify(e.errInfo?.details ?? {});
      check(
        "DB rejects sign with blank text_fr",
        e.code === 121 && d.includes("French text is required on every sign"),
        `code=${e.code} ${d.slice(0, 300)}`,
      );
    }

    // 8b. warm timing: single actions, proposed -> verified (second run has a warm connection pool)
    for (const kind of ["mark_sold_out", "mark_available", "mark_sold_out"] as const) {
      const t1 = Date.now();
      const marks: string[] = [];
      let w = await L.proposeDecided(db, {
        run_id: `run_check_${Date.now()}`,
        type: kind,
        actor: sam,
        utterance: { text: "We're out of lattes", lang: "en", stt: "typed" },
        evidence: [],
        params: { item_id: "item_latte" },
        decision: { decision: "allow", rule_id: "staff_stock", version: 1, reason: "Staff may mark items sold out or available." },
        begin: true,
      });
      marks.push(`proposed+begin ${Date.now() - t1}`);
      w = await L.publish(db, w._id, { onStep: (s) => { marks.push(`${s.label} ${Date.now() - t1}`); } });
      const total = Date.now() - t1;
      console.log(`TIME  ${kind} proposed->verified: ${total} ms  [${marks.join(" | ")}]`);
      const lt = await targets(db, "item_latte");
      const out = kind === "mark_sold_out";
      check(`${kind} verified`, w.status === "verified" && lt.sign.sold_out === out && lt.till.available === !out);
    }

    // 9. stale chain head (another writer reset control): one re-read, chain stays valid
    await seed(db, true, () => {});
    await L.auditEvent(db, { event: "check.stale_head", actor: marie, detail: {} });
    const c3 = await L.verifyChain(db);
    check("stale chain head recovered", c3.ok && c3.entries === 1, `entries=${c3.entries} broken_at=${c3.broken_at}`);

    await seed(db, true, () => {});
  } finally {
    await client.close();
  }
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("FAIL  crashed:", e);
  process.exit(1);
});
