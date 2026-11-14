import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../src/gate.ts";
import type {
  ActionDoc,
  ActionParams,
  ActionType,
  MenuItem,
  Policy,
  Role,
} from "../src/types.ts";

const now = new Date();
function rule(
  p: Partial<Policy> & Pick<Policy, "rule_id" | "effect" | "actions" | "roles">,
): Policy {
  return {
    _id: `pol_${p.rule_id}_v1`,
    shop_id: "shop_demo",
    version: 1,
    status: "active",
    conditions: {},
    reason_en: `${p.rule_id} reason`,
    created_by: "usr_marie",
    created_at: now,
    ...p,
  };
}

const RULES: Policy[] = [
  rule({
    rule_id: "owner_prices",
    effect: "allow",
    actions: ["set_price"],
    roles: ["owner"],
    conditions: { min_price: 0.5, max_change_pct: 60 },
  }),
  rule({
    rule_id: "owner_promos",
    effect: "allow",
    actions: ["start_promo"],
    roles: ["owner"],
    conditions: { max_discount_pct: 50 },
  }),
  rule({
    rule_id: "staff_stock",
    effect: "allow",
    actions: ["mark_sold_out", "mark_available"],
    roles: ["owner", "employee"],
  }),
  rule({
    rule_id: "staff_promos",
    effect: "allow",
    actions: ["start_promo"],
    roles: ["employee"],
    conditions: { max_discount_pct: 10 },
    over_limit: "needs_approval",
  }),
  rule({
    rule_id: "french_required",
    effect: "deny",
    actions: ["*"],
    roles: ["*"],
    conditions: { missing_fr_text: true },
  }),
];

const muffin: MenuItem = {
  _id: "item_muffin",
  shop_id: "shop_demo",
  name_en: "Muffin",
  name_fr: "Muffin",
  aliases: [],
  base_price: 3.0,
  price: 3.0,
  currency: "CAD",
  available: true,
  promo: null,
  last_action_id: null,
};

const actor = (role: Role) => ({
  human_id: role === "owner" ? "usr_marie" : "usr_sam",
  role,
  agent_id: "agent_yeschef_v1",
});
const promo = (pct: number, fr = "Promo"): ActionParams => ({
  item_id: "item_muffin",
  discount_pct: pct,
  text_en: "Promo",
  text_fr: fr,
  ends_at: null,
});
const ev = (
  type: ActionType,
  params: ActionParams,
  role: Role,
  extra: Record<string, unknown> = {},
) =>
  evaluate({
    type,
    params,
    actor: actor(role),
    item: muffin,
    rules: RULES,
    ...extra,
  });

function orig(type: ActionType, params: ActionParams, role: Role): ActionDoc {
  return {
    _id: "act_1",
    shop_id: "shop_demo",
    run_id: "run_1",
    type,
    status: "verified",
    actor: actor(role),
    utterance: { text: "", lang: "en", stt: "typed" },
    evidence: [],
    params,
    policy: { decision: "allow", rule_id: null, version: null, reason: null },
    targets: [],
    undo_of: null,
    created_at: now,
    updated_at: now,
  };
}

test("owner 50% promo is allowed by owner_promos", () => {
  const d = ev("start_promo", promo(50), "owner");
  assert.equal(d.decision, "allow");
  assert.equal(d.rule_id, "owner_promos");
  assert.equal(d.version, 1);
});

test("owner 90% promo is denied", () => {
  const d = ev("start_promo", promo(90), "owner");
  assert.equal(d.decision, "deny");
  assert.equal(d.rule_id, "owner_promos");
});

test("employee 10% promo is allowed by staff_promos", () => {
  const d = ev("start_promo", promo(10), "employee");
  assert.equal(d.decision, "allow");
  assert.equal(d.rule_id, "staff_promos");
});

test("employee 20% promo needs the owner's approval", () => {
  const d = ev("start_promo", promo(20), "employee");
  assert.equal(d.decision, "needs_approval");
  assert.equal(d.rule_id, "staff_promos");
  assert.equal(
    d.reason,
    "Employees may run promos up to 10% off; 20% needs the owner's approval.",
  );
});

test("employee 100% promo is denied (the owner could not do it either)", () => {
  const d = ev("start_promo", promo(100), "employee");
  assert.equal(d.decision, "deny");
  assert.equal(d.rule_id, "staff_promos");
});

test("employee set_price falls to default deny", () => {
  const d = ev("set_price", { item_id: "item_muffin", price: 2.5 }, "employee");
  assert.deepEqual(d, {
    decision: "deny",
    rule_id: "default_deny",
    version: 0,
    reason: "No rule lets an employee set a price.",
  });
});

test("owner set_price within limits is allowed", () => {
  const d = ev("set_price", { item_id: "item_muffin", price: 3.5 }, "owner");
  assert.equal(d.decision, "allow");
  assert.equal(d.rule_id, "owner_prices");
});

test("owner set_price to 0 is denied by min_price", () => {
  const d = ev("set_price", { item_id: "item_muffin", price: 0 }, "owner");
  assert.equal(d.decision, "deny");
  assert.equal(d.rule_id, "owner_prices");
  assert.match(d.reason!, /below/);
});

test("owner set_price beyond max_change_pct is denied", () => {
  const d = ev("set_price", { item_id: "item_muffin", price: 6 }, "owner");
  assert.equal(d.decision, "deny");
  assert.match(d.reason!, /at most 60%/);
});

test("employee may mark sold out and available", () => {
  assert.equal(
    ev("mark_sold_out", { item_id: "item_muffin" }, "employee").rule_id,
    "staff_stock",
  );
  assert.equal(
    ev("mark_available", { item_id: "item_muffin" }, "employee").decision,
    "allow",
  );
});

test("promo with blank text_fr is denied by french_required", () => {
  const d = ev("start_promo", promo(10, "  "), "owner");
  assert.equal(d.decision, "deny");
  assert.equal(d.rule_id, "french_required");
});

test("french_required does not block non-text actions", () => {
  assert.equal(
    ev("mark_sold_out", { item_id: "item_muffin" }, "owner").decision,
    "allow",
  );
});

test("employee undo of an owner price change is denied", () => {
  const d = ev("undo", {}, "employee", {
    original: orig(
      "set_price",
      { item_id: "item_muffin", price: 3.5 },
      "owner",
    ),
  });
  assert.equal(d.decision, "deny");
  assert.equal(d.rule_id, "default_deny");
  assert.match(d.reason!, /undo_any/);
});

test("employee undo of a sold-out is allowed", () => {
  const d = ev("undo", {}, "employee", {
    original: orig("mark_sold_out", { item_id: "item_muffin" }, "employee"),
  });
  assert.equal(d.decision, "allow");
  assert.equal(d.rule_id, "staff_stock");
});

test("owner undo of an owner price change is allowed", () => {
  const d = ev("undo", {}, "owner", {
    original: orig(
      "set_price",
      { item_id: "item_muffin", price: 3.5 },
      "owner",
    ),
  });
  assert.equal(d.decision, "allow");
});

test("undo with nothing to undo is denied", () => {
  assert.equal(ev("undo", {}, "owner").decision, "deny");
});

test("retired rules are ignored", () => {
  const rules = RULES.map((r) =>
    r.rule_id === "staff_stock" ? { ...r, status: "retired" as const } : r,
  );
  const d = evaluate({
    type: "mark_sold_out",
    params: { item_id: "item_muffin" },
    actor: actor("employee"),
    item: muffin,
    rules,
  });
  assert.equal(d.rule_id, "default_deny");
  assert.equal(d.reason, "No rule lets an employee mark an item sold out.");
});
