// One spoken sentence in, checked actions out.
// Order is fixed: record the request, judge it in code, and only then touch a target.
import type { Db } from "mongodb";
import { understand } from "./brain";
import { evaluate } from "./gate";
import * as ledger from "./ledger";
import {
  AGENT_ID,
  COUNTER_ID,
  type Authority,
  type ActionDoc,
  type ActionParams,
  type ActionType,
  type Actor,
  type Env,
  type MenuItem,
  type PlannedCall,
  type Role,
  type RunTrace,
  type TraceStep,
  type UtteranceResult,
} from "./types";

type Emit = (trace: RunTrace) => void;
type Result = UtteranceResult["results"][number];

const id = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const money = (n: number) => `$${n.toFixed(2)}`;
const plural = (item: MenuItem | null | undefined) =>
  item ? `${item.name_en}s` : "That item";

/** What was done, in words short enough to speak. */
function describe(
  type: ActionType,
  params: ActionParams,
  item: MenuItem | null | undefined,
): string {
  const name = item?.name_en ?? "that item";
  switch (type) {
    case "set_price":
      return `${name} is now ${money(params.price ?? 0)}`;
    case "start_promo":
      return `${name}: ${params.text_en ?? `${params.discount_pct}% off`}`;
    case "mark_sold_out":
      return `${plural(item)} are marked sold out`;
    case "mark_available":
      return `${plural(item)} are back on the menu`;
    default:
      return "the last change is undone";
  }
}

/** What an undo put back, in words. */
function describeUndo(original: ActionDoc, item: MenuItem | null | undefined): string {
  const name = item?.name_en ?? "that item";
  switch (original.type) {
    case "start_promo":
      return `Undone. The ${name.toLowerCase()} promo is off`;
    case "set_price":
      return `Undone. ${name} is back to its previous price`;
    case "mark_sold_out":
    case "mark_available":
      // The item goes back to whatever it was before, which may itself have been sold out.
      return `Undone. ${plural(item)} are back to how they were`;
    default:
      return "Undone";
  }
}

function summary(call: PlannedCall, menu: MenuItem[]): string {
  const item =
    "item_id" in call && call.item_id
      ? menu.find((m) => m._id === call.item_id)
      : null;
  const name = item?.name_en ?? "";
  switch (call.tool) {
    case "set_price":
      return `set_price ${name} ${money(call.price)}`;
    case "start_promo":
      return `start_promo ${name} ${call.discount_pct}%${call.ends_at ? ` until ${call.ends_at}` : ""}`;
    case "mark_sold_out":
      return `mark_sold_out ${name}`;
    case "mark_available":
      return `mark_available ${name}`;
    case "explain":
      return `explain ${name}`.trim();
    default:
      return call.tool;
  }
}

/** Run one allowed action against the three targets, reporting each step to the screens. */
async function run(
  db: Db,
  env: Env,
  action: ActionDoc,
  step: (s: TraceStep) => void,
): Promise<ActionDoc> {
  const slowMs = Number((env as any).slowMs ?? 0) || (env.DEMO_SLOW === "1" ? 2000 : 0);
  return ledger.publish(db, action._id, { slowMs, onStep: (s) => step(s) });
}

export async function handleUtterance(
  db: Db,
  env: Env,
  input: { human_id: string; text: string; stt: "elevenlabs" | "typed" },
  emit: Emit,
): Promise<UtteranceResult> {
  const run_id = id("run");
  const t0 = Date.now();
  const lap = (label: string) => console.log(`[timing] ${label} +${Date.now() - t0}ms`);
  const text = (input.text ?? "").trim();
  // One parallel read: who is speaking, the kill switch, the menu and the active rules.
  const [identity, haltedNow, menu, rules, session] = await Promise.all([
    ledger.getIdentity(db, input.human_id),
    ledger.isHalted(db),
    ledger.loadMenu(db),
    ledger.loadRules(db),
    ledger.getOwnerSession(db, input.human_id),
  ]);
  if (
    !identity ||
    identity.kind !== "human" ||
    !identity.active ||
    (identity.role !== "owner" && identity.role !== "employee")
  ) {
    return {
      run_id,
      results: [],
      say: "I don't know who is speaking, so nothing was changed.",
    };
  }
  // The counter is a shared terminal trusted at employee level. Choosing a name there is a claim.
  // Owner authority exists only while the owner has a live session opened from her own device.
  let role = identity.role as Role;
  let actorId = identity._id;
  let claim: { role: Role } | null = null;
  let authority: Authority = { claimed: identity._id, verified: false, method: "counter_terminal" };
  let who = `${identity.name} (${role}, at the counter)`;
  if (identity.role === "owner") {
    if (session) {
      authority = {
        claimed: identity._id,
        verified: true,
        method: "owner_device_session",
        session_expires_at: session.expires_at,
      };
      who = `${identity.name} (owner, checked in from her own device)`;
    } else {
      role = "employee";
      actorId = COUNTER_ID;
      claim = { role: "owner" };
      who = `someone at the counter, speaking as ${identity.name} (not verified)`;
    }
  }
  const actor: Actor = { human_id: actorId, role, agent_id: AGENT_ID };

  const trace: RunTrace = {
    run_id,
    speaker: claim ? `Someone at the counter, as ${identity.name}` : identity.name,
    role,
    text,
    steps: [],
    say: null,
    done: false,
  };
  const step = (s: TraceStep) => {
    trace.steps.push(s);
    emit({ ...trace, steps: [...trace.steps] });
  };
  const finish = (say: string, results: Result[]): UtteranceResult => {
    trace.say = say;
    trace.done = true;
    emit({ ...trace, steps: [...trace.steps] });
    return { run_id, results, say };
  };

  step({
    key: "heard",
    label: `Heard ${who}`,
    status: "info",
    detail: text,
  });
  if (!text) return finish("I didn't hear anything, chef.", []);

  // The kill switch is read from Atlas on every request.
  if (haltedNow) {
    await ledger.auditEvent(db, {
      event: "halt.refused",
      run_id,
      actor,
      detail: { utterance: text },
    });
    step({
      key: "note",
      label: "Stopped: the kill switch is on",
      status: "blocked",
    });
    return finish(
      "The kitchen is stopped, chef. Clear the stop switch first.",
      [],
    );
  }

  lap("identity+halt+menu+rules");
  const u = await understand(env, { transcript: text, menu, role });
  lap(`understand (extract ${u.timings.extract_ms}ms, plan ${u.timings.plan_ms}ms)`);

  const quoted = u.evidence
    .filter((e) => e.value !== null && e.quote)
    .map((e) => `${e.field} = ${e.value} (“${e.quote}”)`);
  step({
    key: "extracted",
    label: `Extracted ${quoted.length} value${quoted.length === 1 ? "" : "s"} (${u.extraction_source})`,
    status: "info",
    detail: quoted.join(" · ") || "no values",
  });
  step({
    key: "planned",
    label: `Planned ${u.calls.length} action${u.calls.length === 1 ? "" : "s"}`,
    status: "info",
    detail: u.calls.map((c) => summary(c, menu)).join(" · ") || "nothing to do",
  });

  const results: Result[] = [];
  const done: string[] = [];
  const refused: string[] = [];
  const held: string[] = [];
  const asides: string[] = [];
  let halted = false;

  // A number the planner produced that nobody said: recorded and dropped, never published.
  for (const r of u.rejected) {
    await ledger.auditEvent(db, {
      event: "plan.rejected",
      run_id,
      actor,
      detail: { call: r.call, reason: r.reason, utterance: text },
    });
    step({
      key: "note",
      label: `Dropped ${summary(r.call, menu)}`,
      status: "blocked",
      detail: r.reason,
    });
    asides.push("I need the number said out loud for that one.");
  }

  for (const call of u.calls) {
    if (call.tool === "ask_clarification") {
      await ledger.auditEvent(db, {
        event: "clarification.asked",
        run_id,
        actor,
        detail: { question: call.question, utterance: text },
      });
      step({
        key: "note",
        label: "Asked a question instead of guessing",
        status: "info",
        detail: call.question,
      });
      results.push({
        action_id: null,
        type: "ask_clarification",
        status: "clarify",
        reason: call.question,
        item_id: null,
      });
      asides.push(call.question);
      continue;
    }

    if (call.tool === "explain") {
      const answer = await ledger.explain(db, call.item_id);
      step({
        key: "note",
        label: "Answered from the audit record",
        status: "ok",
        detail: answer.action_id ?? undefined,
      });
      results.push({
        action_id: answer.action_id,
        type: "explain",
        status: "explained",
        reason: null,
        item_id: call.item_id,
      });
      asides.push(answer.text);
      continue;
    }

    // Everything below changes the shop, so it is recorded first and judged second.
    let type: ActionType;
    let params: ActionParams;
    let original: ActionDoc | null = null;
    if (call.tool === "undo") {
      original = await ledger.findLastUndoable(db);
      if (!original) {
        step({ key: "note", label: "Nothing to undo", status: "info" });
        asides.push("There's nothing to undo.");
        continue;
      }
      type = "undo";
      params = { item_id: original.params.item_id };
    } else {
      type = call.tool;
      const { tool: _tool, ...rest } = call;
      params = rest as ActionParams;
    }
    const item = menu.find((m) => m._id === params.item_id) ?? null;

    // The gate is pure code: it sees the request, the speaker's role and the rules from Atlas.
    // The request and the verdict are then written together, before anything touches a target.
    const decision = evaluate({ type, params, actor, item, rules, original, claim });
    const judged = await ledger.proposeDecided(db, {
      run_id,
      type,
      actor,
      utterance: { text, lang: "en", stt: input.stt },
      evidence: u.evidence,
      params,
      undo_of: original?._id ?? null,
      decision,
      authority,
      begin: true, // an allowed action starts publishing in the same transaction that records the verdict
    });
    lap(`proposeDecided ${type}`);
    const what = original
      ? `undo of “${describe(original.type, original.params, item)}”`
      : summary(call, menu);
    const cite = `${decision.rule_id} v${decision.version}`;

    if (decision.decision === "deny") {
      step({
        key: "gate",
        label: `Blocked: ${what}`,
        status: "blocked",
        detail: `${cite} · ${decision.reason}`,
      });
      results.push({
        action_id: judged._id,
        type,
        status: "blocked",
        reason: decision.reason,
        item_id: params.item_id ?? null,
      });
      if (decision.reason && !refused.includes(decision.reason))
        refused.push(decision.reason);
      continue;
    }
    if (decision.decision === "needs_approval") {
      step({
        key: "gate",
        label: `Held for the owner: ${what}`,
        status: "held",
        detail: `${cite} · ${decision.reason}`,
      });
      results.push({
        action_id: judged._id,
        type,
        status: "pending_approval",
        reason: decision.reason,
        item_id: params.item_id ?? null,
      });
      if (decision.reason && !held.includes(decision.reason))
        held.push(decision.reason);
      continue;
    }

    step({
      key: "gate",
      label: `Allowed: ${what}`,
      status: "ok",
      detail: `${cite} · ${decision.reason}`,
    });
    const final = await run(db, env, judged, step);
    lap(`publish ${type} -> ${final.status}`);
    results.push({
      action_id: final._id,
      type,
      status: final.status,
      reason: decision.reason,
      item_id: params.item_id ?? null,
    });
    if (final.status === "verified") {
      done.push(
        original ? describeUndo(original, item) : describe(type, params, item),
      );
    } else if (final.status === "halted") {
      halted = true;
      step({
        key: "note",
        label: "Stopped mid-run; written targets were restored",
        status: "blocked",
      });
      break;
    } else {
      step({
        key: "note",
        label: `Did not complete (${final.status}); written targets were restored`,
        status: "fail",
      });
      asides.push("One change did not go through, and I put things back.");
    }
  }

  // The reply, in the order a person would want to hear it.
  const parts: string[] = [];
  if (halted) parts.push("Stopped, chef. Nothing was left half published.");
  if (done.length) parts.push(`Yes, chef. ${done.join(". ")}.`);
  if (refused.length)
    parts.push(
      `${done.length ? "But one thing is" : "That's"} not a yes, chef. ${refused.join(" ")}${done.length ? "" : " Nothing was published."}`,
    );
  if (held.length)
    parts.push(
      `${claim ? `I can't confirm that's ${identity.name}, chef.` : "I've held that for the owner, chef."} ${held.join(" ")}`,
    );
  parts.push(...asides.filter((a, i) => asides.indexOf(a) === i));
  if (!parts.length) parts.push("I didn't catch a change to the menu, chef.");

  return finish(parts.join(" "), results);
}

/** The owner's answer to a held request. An approval is recorded, then published like any allowed action. */
export async function handleApproval(
  db: Db,
  env: Env,
  input: { action_id: string; approve: boolean; approver_id: string },
  emit: Emit,
): Promise<{ status: string; say: string }> {
  const approver = await ledger.getIdentity(db, input.approver_id);
  if (!approver || approver.role !== "owner")
    return { status: "refused", say: "Only the owner can approve that." };

  const menu = await ledger.loadMenu(db);
  const resolved = await ledger.resolveApproval(db, input.action_id, {
    approve: input.approve,
    approver: { human_id: approver._id, role: "owner" },
  });
  const item = menu.find((m) => m._id === resolved.params.item_id) ?? null;
  const what = describe(resolved.type, resolved.params, item);

  const trace: RunTrace = {
    run_id: resolved.run_id,
    speaker: approver.name,
    role: "owner",
    text: input.approve ? `Approved: ${what}` : `Rejected: ${what}`,
    steps: [],
    say: null,
    done: false,
  };
  const step = (s: TraceStep) => {
    trace.steps.push(s);
    emit({ ...trace, steps: [...trace.steps] });
  };
  const finish = (status: string, say: string) => {
    trace.say = say;
    trace.done = true;
    emit({ ...trace, steps: [...trace.steps] });
    return { status, say };
  };

  if (!input.approve) {
    step({
      key: "gate",
      label: `${approver.name} rejected it`,
      status: "blocked",
      detail: what,
    });
    return finish(
      "rejected",
      `${approver.name} said no, chef. Nothing was published.`,
    );
  }

  step({
    key: "gate",
    label: `${approver.name} approved it from the owner's device`,
    status: "ok",
    detail: `${resolved.policy.rule_id} v${resolved.policy.version} · approved by ${approver._id}`,
  });
  if (await ledger.isHalted(db)) {
    step({
      key: "note",
      label: "Stopped: the kill switch is on",
      status: "blocked",
    });
    return finish(
      "halted",
      "Approved, but the kitchen is stopped. Clear the stop switch first.",
    );
  }
  const final = await run(db, env, resolved, step);
  if (final.status === "verified") {
    return finish(
      "verified",
      `Yes, chef. ${approver.name} approved it. ${what}.`,
    );
  }
  step({
    key: "note",
    label: `Did not complete (${final.status})`,
    status: "fail",
  });
  return finish(
    final.status,
    "Approved, but it did not go through, and I put things back.",
  );
}
