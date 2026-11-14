// Creates the Yes Chef collections, applies validators (strict / error), indexes,
// and enables pre/post images for change streams. Idempotent.
// Run: npx tsx --env-file=.env scripts/validators.ts   (MONGODB_DB overrides the database, default "yeschef")
import { MongoClient, type Db } from "mongodb";
import { pathToFileURL } from "node:url";

const ACTION_TYPES = [
  "set_price",
  "start_promo",
  "mark_sold_out",
  "mark_available",
  "undo",
];
const STATUSES = [
  "proposed",
  "blocked",
  "pending_approval",
  "rejected",
  "allowed",
  "applying",
  "applied",
  "verified",
  "failed",
  "halted",
  "rolled_back",
];
const NUM = ["double", "int", "long", "decimal"];

const signSchema = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "shop_id",
      "text_fr",
      "text_en",
      "price",
      "sold_out",
      "action_id",
      "updated_at",
    ],
    properties: {
      shop_id: {
        bsonType: "string",
        description: "Every sign state belongs to a shop",
      },
      text_fr: {
        bsonType: "string",
        pattern: "\\S",
        description: "French text is required on every sign",
      },
      text_en: {
        bsonType: "string",
        pattern: "\\S",
        description: "English text is required on every sign",
      },
      price: {
        bsonType: NUM,
        minimum: 0,
        description: "Price must be a number and not negative",
      },
      sold_out: {
        bsonType: "bool",
        description: "sold_out must be true or false",
      },
      action_id: {
        bsonType: "string",
        minLength: 1,
        description: "Every sign state must trace to an action",
      },
      updated_at: {
        bsonType: "date",
        description: "updated_at must be a date",
      },
    },
  },
};

const tillSchema = {
  $jsonSchema: {
    bsonType: "object",
    required: ["shop_id", "price", "available", "action_id"],
    properties: {
      shop_id: {
        bsonType: "string",
        description: "Every till entry belongs to a shop",
      },
      price: {
        bsonType: NUM,
        minimum: 0,
        description: "Till price must be a number and not negative",
      },
      available: {
        bsonType: "bool",
        description: "available must be true or false",
      },
      action_id: {
        bsonType: "string",
        minLength: 1,
        description: "Every till state must trace to an action",
      },
    },
  },
};

const actionsValidator = {
  $and: [
    {
      $jsonSchema: {
        bsonType: "object",
        required: [
          "shop_id",
          "run_id",
          "type",
          "status",
          "actor",
          "utterance",
          "policy",
          "targets",
          "created_at",
        ],
        properties: {
          shop_id: {
            bsonType: "string",
            description: "Every action belongs to a shop",
          },
          run_id: {
            bsonType: "string",
            minLength: 1,
            description: "Every action belongs to a spoken run",
          },
          type: {
            enum: ACTION_TYPES,
            description: "Action type must be one the agent knows",
          },
          status: {
            enum: STATUSES,
            description: "Status must be a known lifecycle state",
          },
          actor: {
            bsonType: "object",
            required: ["human_id", "role", "agent_id"],
            description:
              "Every action names the human who asked and the agent that acted",
            properties: {
              human_id: {
                bsonType: "string",
                minLength: 1,
                description: "The human who asked",
              },
              role: {
                enum: ["owner", "employee"],
                description: "The speaker's role",
              },
              agent_id: {
                bsonType: "string",
                minLength: 1,
                description: "The agent that acted",
              },
            },
          },
          utterance: {
            bsonType: "object",
            required: ["text", "lang"],
            description: "Every action records what was said",
            properties: {
              text: { bsonType: "string" },
              lang: { enum: ["en"] },
            },
          },
          policy: {
            bsonType: "object",
            required: ["decision"],
            description: "Every action carries a policy decision",
            properties: {
              decision: {
                enum: ["pending", "allow", "deny", "needs_approval"],
                description: "Policy decision",
              },
            },
          },
          targets: { bsonType: "array", description: "Per-target progress" },
          created_at: { bsonType: "date" },
        },
      },
    },
    {
      $or: [
        {
          status: {
            $in: ["proposed", "blocked", "pending_approval", "rejected"],
          },
        },
        { "policy.decision": "allow" },
      ],
    },
    {
      $or: [
        { "policy.decision": { $ne: "allow" } },
        {
          "policy.rule_id": { $type: "string" },
          "policy.version": { $type: "number" },
        },
      ],
    },
    // Separation of duties: the person who approves can never be the person who asked.
    {
      $expr: {
        $or: [
          { $ne: [{ $type: "$policy.approved_by" }, "string"] },
          { $ne: ["$policy.approved_by", "$actor.human_id"] },
        ],
      },
    },
  ],
};

const auditSchema = {
  $jsonSchema: {
    bsonType: "object",
    required: ["shop_id", "seq", "ts", "event", "actor", "prev_hash", "hash"],
    properties: {
      shop_id: { bsonType: "string" },
      seq: {
        bsonType: NUM,
        minimum: 1,
        description: "Audit entries are numbered from 1",
      },
      ts: {
        bsonType: "string",
        description: "ts is an ISO string so the hash is stable",
      },
      event: {
        bsonType: "string",
        minLength: 1,
        description: "Every audit entry names its event",
      },
      actor: {
        bsonType: "object",
        description: "Every audit entry names who acted",
      },
      prev_hash: {
        bsonType: "string",
        minLength: 1,
        description: "Every audit entry links to the one before",
      },
      hash: {
        bsonType: "string",
        minLength: 1,
        description: "Every audit entry carries its own hash",
      },
    },
  },
};

const policiesSchema = {
  $jsonSchema: {
    bsonType: "object",
    required: ["rule_id", "version", "status", "effect", "actions", "roles"],
    properties: {
      rule_id: {
        bsonType: "string",
        minLength: 1,
        description: "Every rule has a rule_id",
      },
      version: {
        bsonType: NUM,
        minimum: 1,
        description: "Every rule has a numeric version",
      },
      status: {
        enum: ["active", "retired"],
        description: "Rule status is active or retired",
      },
      effect: {
        enum: ["allow", "deny"],
        description: "Rule effect is allow or deny",
      },
      actions: {
        bsonType: "array",
        minItems: 1,
        description: "A rule names the actions it covers",
      },
      roles: {
        bsonType: "array",
        minItems: 1,
        description: "A rule names the roles it covers",
      },
    },
  },
};

const identitiesSchema = {
  $jsonSchema: {
    bsonType: "object",
    required: ["shop_id", "kind", "name", "role"],
    properties: {
      kind: { enum: ["human", "agent"] },
      role: {
        enum: ["owner", "employee", "agent"],
        description: "Role is owner, employee or agent",
      },
    },
  },
};

const menuSchema = {
  $jsonSchema: {
    bsonType: "object",
    required: ["shop_id", "name_en", "name_fr", "price"],
    properties: {
      name_en: {
        bsonType: "string",
        pattern: "\\S",
        description: "English name required",
      },
      name_fr: {
        bsonType: "string",
        pattern: "\\S",
        description: "French name required",
      },
      price: {
        bsonType: NUM,
        minimum: 0,
        description: "Price must not be negative",
      },
    },
  },
};

export const VALIDATORS: Record<string, Record<string, unknown> | null> = {
  identities: identitiesSchema,
  policies: policiesSchema,
  menu_items: menuSchema,
  actions: actionsValidator,
  audit: auditSchema,
  control: null,
  target_sign: signSchema,
  target_menu: signSchema,
  target_till: tillSchema,
};

const PRE_POST = [
  "target_sign",
  "target_menu",
  "target_till",
  "policies",
  "control",
];

export async function applyValidators(
  db: Db,
  log: (s: string) => void = console.log,
): Promise<void> {
  const existing = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map(
      (c) => c.name,
    ),
  );
  for (const [name, validator] of Object.entries(VALIDATORS)) {
    if (!existing.has(name)) {
      await db.createCollection(name);
      log(`created ${name}`);
    }
    const cmd: Record<string, unknown> = { collMod: name };
    if (validator) {
      cmd.validator = validator;
      cmd.validationLevel = "strict";
      cmd.validationAction = "error";
    }
    if (PRE_POST.includes(name))
      cmd.changeStreamPreAndPostImages = { enabled: true };
    if (Object.keys(cmd).length > 1) await db.command(cmd);
  }
  await db.collection("policies").createIndex({ shop_id: 1, status: 1 });
  await db
    .collection("policies")
    .createIndex({ shop_id: 1, rule_id: 1, version: 1 }, { unique: true });
  await db.collection("actions").createIndex({ shop_id: 1, created_at: -1 });
  await db
    .collection("audit")
    .createIndex({ shop_id: 1, seq: 1 }, { unique: true });
  await db.collection("audit").createIndex({ action_id: 1, seq: 1 });
  log(`validators, indexes and pre/post images applied on ${db.databaseName}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI missing");
  const client = new MongoClient(uri);
  try {
    await applyValidators(client.db(process.env.MONGODB_DB || "yeschef"));
  } finally {
    await client.close();
  }
}
