// Seeds Yes Chef data. Idempotent. `--reset` clears actions, audit and the three targets
// and re-seeds everything (control is reset to genesis).
// Run: npx tsx --env-file=.env scripts/seed.ts [--reset]   (MONGODB_DB overrides, default "yeschef")
import { MongoClient, type Db } from "mongodb";
import { pathToFileURL } from "node:url";
import { applyValidators } from "./validators.ts";
import { SHOP_ID, AGENT_ID } from "../src/types.ts";

const ITEMS = [
  {
    _id: "item_coffee",
    name_en: "Coffee",
    name_fr: "Café",
    price: 3.5,
    aliases: [
      "coffee",
      "coffees",
      "café",
      "cafe",
      "filter coffee",
      "café filtre",
    ],
  },
  {
    _id: "item_latte",
    name_en: "Latte",
    name_fr: "Latté",
    price: 4.75,
    aliases: ["latte", "lattes", "latté", "café latte", "caffe latte"],
  },
  {
    _id: "item_croissant",
    name_en: "Croissant",
    name_fr: "Croissant",
    price: 3.25,
    aliases: ["croissant", "croissants"],
  },
  {
    _id: "item_muffin",
    name_en: "Muffin",
    name_fr: "Muffin",
    price: 3.0,
    aliases: ["muffin", "muffins"],
  },
];

function rule(
  rule_id: string,
  effect: "allow" | "deny",
  actions: string[],
  roles: string[],
  conditions: Record<string, unknown>,
  reason_en: string,
  over_limit?: "deny" | "needs_approval",
) {
  const doc: Record<string, unknown> = {
    _id: `pol_${rule_id}_v1`,
    shop_id: SHOP_ID,
    rule_id,
    version: 1,
    status: "active",
    effect,
    actions,
    roles,
    conditions,
    reason_en,
    created_by: "usr_marie",
    created_at: new Date(),
  };
  if (over_limit) doc.over_limit = over_limit;
  return doc;
}

const RULES = [
  rule(
    "owner_prices",
    "allow",
    ["set_price"],
    ["owner"],
    { min_price: 0.5, max_change_pct: 60 },
    "Owners may change prices within 60% of the base price, not below $0.50.",
  ),
  rule(
    "owner_promos",
    "allow",
    ["start_promo"],
    ["owner"],
    { max_discount_pct: 50 },
    "Owners may run promos up to 50% off.",
  ),
  rule(
    "staff_stock",
    "allow",
    ["mark_sold_out", "mark_available"],
    ["owner", "employee"],
    {},
    "Staff may mark items sold out or available.",
  ),
  rule(
    "staff_promos",
    "allow",
    ["start_promo"],
    ["employee"],
    { max_discount_pct: 10 },
    "Employees may run promos up to 10% off.",
    "needs_approval",
  ),
  rule(
    "undo_any",
    "allow",
    ["undo"],
    ["owner", "employee"],
    {},
    "Anyone on staff may undo the last change.",
  ),
  rule(
    "french_required",
    "deny",
    ["set_price", "start_promo", "mark_sold_out", "mark_available"],
    ["*"],
    { missing_fr_text: true },
    "Every sign needs French text.",
  ),
  // Marker rule: the gate never matches it as an ordinary rule.
  rule(
    "owner_device_required",
    "deny",
    ["*"],
    ["owner"],
    { requires_owner_device: true },
    "Owner commands need the owner's own device. Nobody is checked in as the owner, so this was sent to her phone.",
  ),
];

export async function seed(
  db: Db,
  reset: boolean,
  log: (s: string) => void = console.log,
): Promise<void> {
  await applyValidators(db, log);
  if (reset) {
    for (const c of [
      "sessions",
      "actions",
      "audit",
      "target_sign",
      "target_menu",
      "target_till",
    ]) {
      await db.collection(c).deleteMany({});
    }
    log("cleared actions, audit, target_sign, target_menu, target_till");
  }

  const identities = [
    {
      _id: "usr_marie",
      shop_id: SHOP_ID,
      kind: "human",
      name: "Marie",
      role: "owner",
      active: true,
    },
    {
      _id: "usr_sam",
      shop_id: SHOP_ID,
      kind: "human",
      name: "Sam",
      role: "employee",
      active: true,
    },
    {
      _id: "usr_counter",
      shop_id: SHOP_ID,
      kind: "human",
      name: "Someone at the counter",
      role: "employee",
      active: true,
    },
    {
      _id: AGENT_ID,
      shop_id: SHOP_ID,
      kind: "agent",
      name: "Yes Chef agent v1",
      role: "agent",
      active: true,
    },
  ];
  for (const d of identities)
    await db
      .collection<any>("identities")
      .replaceOne({ _id: d._id }, d, { upsert: true });

  for (const r of RULES) {
    if (reset)
      await db
        .collection<any>("policies")
        .replaceOne({ _id: r._id }, r, { upsert: true });
    else
      await db
        .collection<any>("policies")
        .updateOne({ _id: r._id }, { $setOnInsert: r }, { upsert: true });
  }
  if (reset) {
    // Retire any later versions added on stage so the seed rules are the active ones again.
    await db
      .collection("policies")
      .deleteMany({
        shop_id: SHOP_ID,
        _id: { $nin: RULES.map((r) => r._id) } as any,
      });
  }

  const now = new Date();
  for (const it of ITEMS) {
    const menu = {
      _id: it._id,
      shop_id: SHOP_ID,
      name_en: it.name_en,
      name_fr: it.name_fr,
      aliases: it.aliases,
      base_price: it.price,
      price: it.price,
      currency: "CAD",
      available: true,
      promo: null,
      last_action_id: null,
    };
    const sign = {
      _id: it._id,
      shop_id: SHOP_ID,
      text_en: it.name_en,
      text_fr: it.name_fr,
      price: it.price,
      sold_out: false,
      promo_en: null,
      promo_fr: null,
      ends_at: null,
      action_id: "seed",
      updated_at: now,
    };
    const till = {
      _id: it._id,
      shop_id: SHOP_ID,
      price: it.price,
      available: true,
      discount_pct: null,
      action_id: "seed",
      updated_at: now,
    };
    const write = async (coll: string, doc: any) => {
      if (reset)
        await db
          .collection<any>(coll)
          .replaceOne({ _id: doc._id }, doc, { upsert: true });
      else
        await db
          .collection<any>(coll)
          .updateOne({ _id: doc._id }, { $setOnInsert: doc }, { upsert: true });
    };
    await write("menu_items", menu);
    await write("target_sign", sign);
    await write("target_menu", { ...sign });
    await write("target_till", till);
  }

  const control = {
    _id: SHOP_ID,
    halt: false,
    audit_seq: 0,
    last_hash: "genesis",
  };
  if (reset)
    await db
      .collection<any>("control")
      .replaceOne({ _id: SHOP_ID }, control, { upsert: true });
  else
    await db
      .collection<any>("control")
      .updateOne({ _id: SHOP_ID }, { $setOnInsert: control }, { upsert: true });

  log(
    `seeded ${db.databaseName}: ${identities.length} identities, ${RULES.length} rules, ${ITEMS.length} menu items, ` +
      `${ITEMS.length * 3} target docs, control${reset ? " (reset)" : ""}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI missing");
  const client = new MongoClient(uri);
  try {
    await seed(
      client.db(process.env.MONGODB_DB || "yeschef"),
      process.argv.includes("--reset"),
    );
  } finally {
    await client.close();
  }
}
