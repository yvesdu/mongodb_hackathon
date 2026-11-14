// Policy gate: pure, synchronous, deny by default. The language model never reaches this file.
import type {
  ActionParams,
  ActionType,
  GateInput,
  Policy,
  PolicyDecision,
  Role,
} from "./types";

const ACTION_WORDS: Record<ActionType, string> = {
  set_price: "set a price",
  start_promo: "start a promo",
  mark_sold_out: "mark an item sold out",
  mark_available: "mark an item available",
  undo: "undo a change",
};

const ROLE_PLURAL: Record<Role, string> = {
  owner: "owners",
  employee: "employees",
};

/** Actions that publish customer-facing text (need a French line). */
const PUBLISHES_TEXT: ActionType[] = ["start_promo"];

function matches(rule: Policy, type: ActionType, role: Role): boolean {
  return (
    rule.status === "active" &&
    (rule.actions.includes("*") || rule.actions.includes(type)) &&
    (rule.roles.includes("*") || rule.roles.includes(role))
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Returns null if every limit in an allow rule passes, else a plain-English failure. */
function failedLimit(
  rule: Policy,
  type: ActionType,
  params: ActionParams,
  basePrice: number | null,
  role: Role,
): string | null {
  const c = rule.conditions ?? {};
  const who = cap(ROLE_PLURAL[role]);
  if (c.max_discount_pct != null) {
    const d = params.discount_pct;
    if (typeof d !== "number" || !Number.isFinite(d))
      return "No discount was given.";
    if (d > c.max_discount_pct)
      return `${who} may run promos up to ${c.max_discount_pct}% off; ${d}% is over that limit.`;
  }
  if (c.min_price != null) {
    const p = params.price;
    if (typeof p !== "number" || !Number.isFinite(p))
      return "No price was given.";
    if (p < c.min_price)
      return `Prices can't go below ${fmtMoney(c.min_price)}; ${fmtMoney(p)} is too low.`;
  }
  if (c.max_change_pct != null) {
    const p = params.price;
    if (typeof p !== "number" || !Number.isFinite(p))
      return "No price was given.";
    if (basePrice == null || basePrice <= 0)
      return "The item's base price is unknown.";
    const change = (Math.abs(p - basePrice) / basePrice) * 100;
    if (change > c.max_change_pct + 1e-9)
      return `A price can move at most ${c.max_change_pct}% from the base ${fmtMoney(basePrice)}; ${fmtMoney(p)} is a ${Math.round(change)}% change.`;
  }
  void type;
  return null;
}

/** Deny rules: the rule fires when every listed condition holds. */
function denyHolds(
  rule: Policy,
  type: ActionType,
  params: ActionParams,
  basePrice: number | null,
): string | null {
  const c = rule.conditions ?? {};
  const reasons: string[] = [];
  if (c.missing_fr_text) {
    const blank = !params.text_fr || params.text_fr.trim() === "";
    if (!(PUBLISHES_TEXT.includes(type) && blank)) return null;
    reasons.push("The sign needs a French line, and none was given.");
  }
  if (c.max_discount_pct != null) {
    if (!(
      typeof params.discount_pct === "number" &&
      params.discount_pct > c.max_discount_pct
    ))
      return null;
    reasons.push(`Discounts above ${c.max_discount_pct}% are not allowed.`);
  }
  if (c.min_price != null) {
    if (!(typeof params.price === "number" && params.price < c.min_price))
      return null;
    reasons.push(`Prices below ${fmtMoney(c.min_price)} are not allowed.`);
  }
  if (c.max_change_pct != null) {
    if (typeof params.price !== "number" || basePrice == null || basePrice <= 0)
      return null;
    if (
      (Math.abs(params.price - basePrice) / basePrice) * 100 <=
      c.max_change_pct
    )
      return null;
    reasons.push(`Price changes above ${c.max_change_pct}% are not allowed.`);
  }
  return reasons.length
    ? reasons.join(" ")
    : rule.reason_en || "A rule forbids this.";
}

function decide(
  type: ActionType,
  params: ActionParams,
  role: Role,
  basePrice: number | null,
  rules: Policy[],
  allowApproval = true,
): PolicyDecision {
  const active = rules.filter((r) => matches(r, type, role));

  for (const r of active.filter((r) => r.effect === "deny")) {
    const why = denyHolds(r, type, params, basePrice);
    if (why)
      return {
        decision: "deny",
        rule_id: r.rule_id,
        version: r.version,
        reason: why,
      };
  }

  const allows = active.filter((r) => r.effect === "allow");
  const failures: { rule: Policy; why: string }[] = [];
  for (const r of allows) {
    const why = failedLimit(r, type, params, basePrice, role);
    if (why === null)
      return {
        decision: "allow",
        rule_id: r.rule_id,
        version: r.version,
        reason: r.reason_en || `Allowed by ${r.rule_id}.`,
      };
    failures.push({ rule: r, why });
  }

  if (failures.length) {
    if (allowApproval && role !== "owner") {
      const held = failures.find((f) => f.rule.over_limit === "needs_approval");
      if (held) {
        const ownerView = decide(
          type,
          params,
          "owner",
          basePrice,
          rules,
          false,
        );
        if (ownerView.decision === "allow") {
          const lim = held.rule.conditions?.max_discount_pct;
          const reason =
            lim != null && typeof params.discount_pct === "number"
              ? `${cap(ROLE_PLURAL[role])} may run promos up to ${lim}% off; ${params.discount_pct}% needs the owner's approval.`
              : `${held.why.replace(/ is over that limit\.$/, "")} This needs the owner's approval.`;
          return {
            decision: "needs_approval",
            rule_id: held.rule.rule_id,
            version: held.rule.version,
            reason,
          };
        }
      }
    }
    const f = failures[0];
    return {
      decision: "deny",
      rule_id: f.rule.rule_id,
      version: f.rule.version,
      reason: f.why,
    };
  }

  return {
    decision: "deny",
    rule_id: "default_deny",
    version: 0,
    reason: `No rule lets ${role === "owner" ? "an owner" : "an employee"} ${ACTION_WORDS[type]}.`,
  };
}

export function evaluate(input: GateInput): PolicyDecision {
  try {
    const role = input.actor?.role;
    if (role !== "owner" && role !== "employee")
      return {
        decision: "deny",
        rule_id: "default_deny",
        version: 0,
        reason: "Unknown role; nothing is allowed.",
      };
    const rules = Array.isArray(input.rules) ? input.rules : [];
    const base = input.item ? input.item.base_price : null;

    if (input.type === "undo") {
      const orig = input.original;
      if (!orig || orig.type === "undo")
        return {
          decision: "deny",
          rule_id: "default_deny",
          version: 0,
          reason: "There is no change to undo.",
        };
      const d = decide(orig.type, orig.params ?? {}, role, base, rules);
      const what = ACTION_WORDS[orig.type];
      if (d.decision === "allow")
        return {
          ...d,
          reason: `Anyone may undo a change their own role could make (undo_any): ${ROLE_PLURAL[role]} may ${what}.`,
        };
      if (d.decision === "needs_approval")
        return {
          ...d,
          reason: `Undo follows the original rule (undo_any): ${d.reason}`,
        };
      return {
        ...d,
        reason: `You can only undo what your own role could have done (undo_any). ${d.reason}`,
      };
    }

    return decide(input.type, input.params ?? {}, role, base, rules);
  } catch (e) {
    return {
      decision: "deny",
      rule_id: "default_deny",
      version: 0,
      reason: `Gate error: ${(e as Error).message}`,
    };
  }
}
