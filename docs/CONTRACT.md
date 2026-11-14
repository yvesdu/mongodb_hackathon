# Yes Chef: build contract

Shapes live in `src/types.ts`. This file fixes who owns which files, the function signatures between modules, and the HTTP API the pages use.

## What Yes Chef is

A shop worker holds a button and says a change ("two-for-one coffee until noon, and we're out of croissants"). An agent turns it into actions on the shop sign, the online menu and the till, but only if rules stored in MongoDB Atlas allow it. Every step is recorded so a reviewer can reconstruct it. The demo is in English. Each item on the sign also carries a French line, and the database refuses a sign without one.

Hackathon statement: "Agents You Can Audit" (identity, policy and audit in Atlas: collections, schema validation, change streams).

Hard rules: the language model never decides permission (code and the database do). Atlas is the source of truth. Screens redraw from state pushed after Atlas changed, never from an API response. The three targets are mock systems written today and we say so.

## File ownership

| Files                                                                                                                     | Owner         |
| ------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `src/types.ts`, `src/index.ts`, `src/agent.ts`, `src/orchestrator.ts`, `wrangler.jsonc`, `package.json`, `README.md`      | Coordinator   |
| `src/brain.ts`, `src/gate.ts`, `test/gate.test.ts`, `test/brain.*`, `tools/ai-harness/**`                                 | Brain agent   |
| `src/ledger.ts` (may split into `src/ledger/*.ts`), `scripts/seed.ts`, `scripts/validators.ts`, `scripts/ledger-check.ts` | Ledger agent  |
| `public/**`, `src/voice.ts`                                                                                               | Screens agent |

Do not edit files you do not own. Do not run git. Do not add npm dependencies (ask in your report). Dependencies available: `agents`, `mongodb`, `zod`, `tsx`, `wrangler`.

## Module signatures

### `src/brain.ts` (Brain agent)

```ts
export async function understand(
  env: Env,
  input: { transcript: string; menu: MenuItem[]; role: Role },
): Promise<Understanding>;
```

- Extract typed values with Clairic, plan tool calls with a tool-calling model, then drop any call whose price, percentage or time is not backed by an extracted value (`rejected`).
- Never throws for model trouble: on a Clairic failure use the structured-output fallback and set `extraction_source: "fallback"`.

### `src/gate.ts` (Brain agent)

```ts
export function evaluate(input: GateInput): PolicyDecision; // pure, synchronous, deny by default
```

### `src/ledger.ts` (Ledger agent)

All take a `Db` from the `mongodb` driver as first argument.

```ts
loadRules(db): Promise<Policy[]>                       // active rules for SHOP_ID
loadMenu(db): Promise<MenuItem[]>
getIdentity(db, human_id): Promise<Identity | null>
isHalted(db): Promise<boolean>                          // always reads Atlas
setHalt(db, halt: boolean, actor: Actor): Promise<void> // audit: halt.set / halt.cleared
auditEvent(db, e: { event: string; action_id?: string | null; run_id?: string | null; actor: Actor; detail?: Record<string, unknown> }): Promise<void>
proposeAction(db, input: { run_id: string; type: ActionType; actor: Actor; utterance: ActionDoc["utterance"]; evidence: Evidence[]; params: ActionParams; undo_of?: string | null }): Promise<ActionDoc>
recordDecision(db, action_id: string, decision: PolicyDecision): Promise<ActionDoc>   // -> allowed | blocked | pending_approval
resolveApproval(db, action_id: string, input: { approve: boolean; approver: { human_id: string; role: Role } }): Promise<ActionDoc>  // pending_approval -> allowed | rejected
publish(db, action_id: string, opts?: { slowMs?: number; onStep?: (s: TraceStep) => void | Promise<void> }): Promise<ActionDoc>  // allowed -> verified | halted | failed. Handles type "undo" by restoring the original's targets.
findLastUndoable(db): Promise<ActionDoc | null>         // most recent verified, non-undo action
explain(db, item_id: string | null): Promise<{ text: string; action_id: string | null }>  // spoken "why", built only from actions + audit
snapshot(db): Promise<Snapshot>
getRecord(db, action_id: string | null): Promise<RecordView | null>   // null id = most recent action
listActions(db, limit: number): Promise<Record<string, unknown>[]>
verifyChain(db): Promise<{ ok: boolean; entries: number; broken_at: number | null }>
```

## HTTP API (what the pages call)

Base is the deployed Worker. Routes marked "counter key" need header `x-key: <COUNTER_KEY>`; "owner key" needs `x-key: <OWNER_KEY>`. Pages read the key from their own `?key=` query parameter.

| Route                                        | Auth        | Body                                                                                 | Returns                                                 |
| -------------------------------------------- | ----------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `POST /api/stt`                              | counter key | raw audio bytes (`content-type: audio/webm` or whatever MediaRecorder produced)      | `{ text: string }`                                      |
| `POST /api/tts`                              | none        | `{ text: string }`                                                                   | `audio/mpeg` stream                                     |
| `POST /api/utterance`                        | counter key | `{ human_id: "usr_marie" \| "usr_sam", text: string, stt: "elevenlabs" \| "typed" }` | `UtteranceResult`                                       |
| `POST /api/approve`                          | owner key   | `{ action_id: string, approve: boolean }`                                            | `{ status: string, say: string }`                       |
| `POST /api/halt`                             | counter key | `{ halt: boolean }`                                                                  | `{ halt: boolean }`                                     |
| `GET /api/state`                             | none        |                                                                                      | `ShopState`                                             |
| `GET /api/record?action_id=<id>`             | none        | (`action_id` optional: latest)                                                       | `RecordView`                                            |
| `GET /api/actions?limit=20`                  | none        |                                                                                      | action list                                             |
| WebSocket `/agents/yes-chef-agent/shop_demo` | none        |                                                                                      | messages `{ type: "cf_agent_state", state: ShopState }` |

Seeded identities: `usr_marie` (Marie, owner), `usr_sam` (Sam, employee), `agent_yeschef_v1`.

Menu: coffee 3.50, latte 4.75, croissant 3.25, muffin 3.00 (ids `item_coffee`, `item_latte`, `item_croissant`, `item_muffin`).
