/* Yes Chef shared browser helpers. Plain JS, no build step.
 * Live mode: GET /api/state once, then WebSocket /agents/yes-chef-agent/shop_demo
 * Mock mode (?mock=1): fake ShopState + fake API replies, synced between tabs/iframes via localStorage.
 */
(function () {
  "use strict";
  var qs = new URLSearchParams(location.search);
  var MOCK = qs.has("mock") && qs.get("mock") !== "0";
  var KEY = qs.get("key") || "";
  var MOCK_KEY = "yc-mock-state-v1";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }
  function money(n) {
    var v = Number(n);
    if (!isFinite(v)) return "";
    return "$" + v.toFixed(2);
  }
  function withMock(href) {
    // keep mock (and key) when linking between pages
    var u = new URL(href, location.href);
    if (MOCK && !u.searchParams.has("mock")) u.searchParams.set("mock", "1");
    return u.pathname + u.search;
  }

  // ---------------------------------------------------------------- mock data
  function seedState() {
    var now = new Date().toISOString();
    var sign = [
      {
        item_id: "item_coffee",
        text_en: "Coffee",
        text_fr: "Café",
        price: 3.5,
        sold_out: false,
        promo_en: "Two for one",
        promo_fr: "Deux pour un",
        ends_at: "12:00",
        action_id: "act_mock_promo",
        updated_at: now,
      },
      {
        item_id: "item_latte",
        text_en: "Latte",
        text_fr: "Café au lait",
        price: 4.75,
        sold_out: false,
        promo_en: null,
        promo_fr: null,
        ends_at: null,
        action_id: "seed",
        updated_at: now,
      },
      {
        item_id: "item_croissant",
        text_en: "Croissant",
        text_fr: "Croissant au beurre",
        price: 3.25,
        sold_out: true,
        promo_en: null,
        promo_fr: null,
        ends_at: null,
        action_id: "act_mock_soldout",
        updated_at: now,
      },
      {
        item_id: "item_muffin",
        text_en: "Muffin",
        text_fr: "Muffin aux bleuets",
        price: 3.0,
        sold_out: false,
        promo_en: null,
        promo_fr: null,
        ends_at: null,
        action_id: "seed",
        updated_at: now,
      },
    ];
    return {
      sign: sign,
      menu: JSON.parse(JSON.stringify(sign)),
      till: [
        {
          item_id: "item_coffee",
          price: 3.5,
          available: true,
          discount_pct: 50,
          action_id: "act_mock_promo",
        },
        {
          item_id: "item_latte",
          price: 4.75,
          available: true,
          discount_pct: null,
          action_id: "seed",
        },
        {
          item_id: "item_croissant",
          price: 3.25,
          available: false,
          discount_pct: null,
          action_id: "act_mock_soldout",
        },
        {
          item_id: "item_muffin",
          price: 3.0,
          available: true,
          discount_pct: null,
          action_id: "seed",
        },
      ],
      halted: qs.get("halted") === "1",
      pending: [
        {
          action_id: "act_mock_held",
          requested_by: "Sam",
          role: "employee",
          summary: "20% off Muffin",
          utterance: "Let's do twenty percent off muffins until close.",
          reason: "Employees may run promos up to 10% off.",
          created_at: now,
        },
      ],
      trace: {
        run_id: "run_mock1",
        speaker: "Marie",
        role: "owner",
        text: "Two-for-one coffee until noon, and we're out of croissants.",
        steps: [
          {
            key: "heard",
            label: "Heard Marie (owner)",
            status: "ok",
            detail: "ElevenLabs scribe_v3",
          },
          {
            key: "extracted",
            label: "Extracted 4 values",
            status: "ok",
            detail: "item=coffee, discount=50%, ends=12:00, sold_out=croissant",
          },
          {
            key: "planned",
            label: "Planned 2 actions",
            status: "ok",
            detail: "start_promo, mark_sold_out",
          },
          {
            key: "gate",
            label: "Allowed by owner_all v1",
            status: "ok",
            detail: "Owners may change anything.",
          },
          { key: "target", label: "Sign written", status: "ok" },
          { key: "target", label: "Menu written", status: "ok" },
          { key: "target", label: "Till written", status: "ok" },
          { key: "verified", label: "Verified on 3 targets", status: "ok" },
        ],
        say: "Yes, chef. Two for one on coffee until noon. Croissants are sold out.",
        done: true,
      },
      updatedAt: Date.now(),
    };
  }

  function loadMock() {
    try {
      var raw = localStorage.getItem(MOCK_KEY);
      if (raw) {
        var s = JSON.parse(raw);
        if (s && Date.now() - (s.updatedAt || 0) < 15 * 60 * 1000) {
          if (qs.get("halted") === "1") s.halted = true;
          return s;
        }
      }
    } catch (e) {}
    return seedState();
  }
  var mockState = MOCK ? loadMock() : null;
  var listeners = [];
  function pushMock(next) {
    next.updatedAt = Date.now();
    mockState = next;
    try {
      localStorage.setItem(MOCK_KEY, JSON.stringify(next));
    } catch (e) {}
    listeners.forEach(function (fn) {
      fn(JSON.parse(JSON.stringify(next)));
    });
  }
  if (MOCK) {
    window.addEventListener("storage", function (ev) {
      if (ev.key !== MOCK_KEY || !ev.newValue) return;
      try {
        mockState = JSON.parse(ev.newValue);
        listeners.forEach(function (fn) {
          fn(JSON.parse(JSON.stringify(mockState)));
        });
      } catch (e) {}
    });
  }

  var ITEM_WORDS = [
    ["item_coffee", /\bcoffees?\b/i],
    ["item_latte", /\blattes?\b/i],
    ["item_croissant", /\bcroissants?\b/i],
    ["item_muffin", /\bmuffins?\b/i],
  ];
  var NUM_WORDS = {
    five: 5,
    ten: 10,
    fifteen: 15,
    twenty: 20,
    "twenty five": 25,
    thirty: 30,
    fifty: 50,
  };
  function findItem(clause) {
    for (var i = 0; i < ITEM_WORDS.length; i++)
      if (ITEM_WORDS[i][1].test(clause)) return ITEM_WORDS[i][0];
    return null;
  }
  function endsAt(clause) {
    if (/\bnoon\b/i.test(clause)) return "12:00";
    var m = clause.match(/until\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (!m) return null;
    var h = +m[1];
    if (m[3] && m[3].toLowerCase() === "pm" && h < 12) h += 12;
    return (h < 10 ? "0" : "") + h + ":" + (m[2] || "00");
  }
  function mockPlan(text) {
    var calls = [];
    text.split(/,|;|\band\b|\balso\b/i).forEach(function (clause) {
      var item = findItem(clause);
      if (!item) return;
      if (/sold out|out of|no more/i.test(clause))
        return calls.push({ tool: "mark_sold_out", item_id: item });
      if (/\bback\b|available|in stock/i.test(clause))
        return calls.push({ tool: "mark_available", item_id: item });
      if (/two[- ]for[- ]one|2[- ]for[- ]1|bogo/i.test(clause))
        return calls.push({
          tool: "start_promo",
          item_id: item,
          discount_pct: 50,
          text_en: "Two for one",
          text_fr: "Deux pour un",
          ends_at: endsAt(clause),
        });
      var pm = clause.match(/(\d+)\s*(%|percent)/i);
      var pct = pm ? +pm[1] : null;
      if (pct == null)
        for (var w in NUM_WORDS)
          if (new RegExp("\\b" + w + "\\s+percent", "i").test(clause))
            pct = NUM_WORDS[w];
      if (pct != null)
        return calls.push({
          tool: "start_promo",
          item_id: item,
          discount_pct: pct,
          text_en: pct + "% off",
          text_fr: pct + " % de rabais",
          ends_at: endsAt(clause),
        });
      var px = clause.match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
      if (px)
        return calls.push({ tool: "set_price", item_id: item, price: +px[1] });
    });
    return calls;
  }
  function itemName(id) {
    var s = (mockState.sign || []).filter(function (x) {
      return x.item_id === id;
    })[0];
    return s ? s.text_en : id;
  }
  function mockGate(call, role) {
    if (role === "owner")
      return {
        decision: "allow",
        rule: "owner_all v1",
        reason: "Owners may change anything.",
      };
    if (call.tool === "set_price")
      return {
        decision: "deny",
        rule: "default_deny",
        reason: "No rule lets an employee set a price.",
      };
    if (call.tool === "start_promo" && call.discount_pct > 10)
      return {
        decision: "needs_approval",
        rule: "employee_promo v1",
        reason: "Employees may run promos up to 10% off.",
      };
    return {
      decision: "allow",
      rule: "employee_stock v1",
      reason: "Employees may mark items sold out or back.",
    };
  }
  function describe(call) {
    var n = itemName(call.item_id);
    if (call.tool === "mark_sold_out") return n + " sold out";
    if (call.tool === "mark_available") return n + " back on";
    if (call.tool === "set_price") return n + " now " + money(call.price);
    if (call.tool === "start_promo")
      return (
        (call.discount_pct === 50
          ? "Two for one on " + n
          : call.discount_pct + "% off " + n) +
        (call.ends_at ? " until " + call.ends_at : "")
      );
    return call.tool;
  }
  function applyCall(s, call, action_id) {
    ["sign", "menu"].forEach(function (k) {
      s[k].forEach(function (it) {
        if (it.item_id !== call.item_id) return;
        it.action_id = action_id;
        it.updated_at = new Date().toISOString();
        if (call.tool === "mark_sold_out") it.sold_out = true;
        if (call.tool === "mark_available") it.sold_out = false;
        if (call.tool === "set_price") it.price = call.price;
        if (call.tool === "start_promo") {
          it.promo_en = call.text_en;
          it.promo_fr = call.text_fr;
          it.ends_at = call.ends_at;
        }
      });
    });
    s.till.forEach(function (t) {
      if (t.item_id !== call.item_id) return;
      t.action_id = action_id;
      if (call.tool === "mark_sold_out") t.available = false;
      if (call.tool === "mark_available") t.available = true;
      if (call.tool === "set_price") t.price = call.price;
      if (call.tool === "start_promo") t.discount_pct = call.discount_pct;
    });
  }
  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }
  function wait(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  async function mockUtterance(body) {
    var who =
      body.human_id === "usr_sam"
        ? { name: "Sam", role: "employee" }
        : { name: "Marie", role: "owner" };
    var run_id = "run_" + Date.now().toString(36);
    var s = clone(mockState);
    var trace = {
      run_id: run_id,
      speaker: who.name,
      role: who.role,
      text: body.text,
      steps: [],
      say: null,
      done: false,
    };
    function step(st) {
      trace.steps.push(st);
      s = clone(mockState);
      s.trace = clone(trace);
      pushMock(s);
    }
    step({
      key: "heard",
      label: "Heard " + who.name + " (" + who.role + ")",
      status: "ok",
      detail: body.stt === "typed" ? "typed" : "ElevenLabs scribe_v3",
    });
    await wait(450);
    var calls = mockPlan(body.text);
    step({
      key: "extracted",
      label:
        "Extracted " +
        calls.length +
        " value set" +
        (calls.length === 1 ? "" : "s"),
      status: calls.length ? "ok" : "info",
    });
    await wait(400);
    if (!calls.length) {
      trace.say = "Sorry, chef, I didn't catch a change. Which item?";
      trace.done = true;
      step({
        key: "planned",
        label: "Nothing to do",
        status: "info",
        detail: "asked to clarify",
      });
      return {
        run_id: run_id,
        results: [
          {
            action_id: null,
            type: "ask_clarification",
            status: "clarify",
            reason: null,
            item_id: null,
          },
        ],
        say: trace.say,
      };
    }
    step({
      key: "planned",
      label:
        "Planned " +
        calls
          .map(function (c) {
            return c.tool;
          })
          .join(", "),
      status: "ok",
    });
    await wait(400);
    var results = [],
      says = [];
    for (var i = 0; i < calls.length; i++) {
      var c = calls[i],
        g = mockGate(c, who.role),
        aid = "act_" + Date.now().toString(36) + i;
      if (mockState.halted) {
        step({
          key: "gate",
          label: "Shop halted",
          status: "blocked",
          detail: "kill switch is on",
        });
        results.push({
          action_id: aid,
          type: c.tool,
          status: "halted",
          reason: "halted",
          item_id: c.item_id,
        });
        says.push("The shop is halted, nothing changed.");
        continue;
      }
      if (g.decision === "deny") {
        step({
          key: "gate",
          label: "Blocked: " + describe(c),
          status: "blocked",
          detail: g.rule + " · " + g.reason,
        });
        results.push({
          action_id: aid,
          type: c.tool,
          status: "blocked",
          reason: g.reason,
          item_id: c.item_id,
        });
        says.push("That's not a yes, chef. " + g.reason);
      } else if (g.decision === "needs_approval") {
        step({
          key: "gate",
          label: "Held for owner: " + describe(c),
          status: "held",
          detail: g.rule + " · " + g.reason,
        });
        s = clone(mockState);
        s.pending.push({
          action_id: aid,
          requested_by: who.name,
          role: who.role,
          summary: describe(c),
          utterance: body.text,
          reason: g.reason,
          created_at: new Date().toISOString(),
          _call: c,
        });
        s.trace = clone(trace);
        pushMock(s);
        results.push({
          action_id: aid,
          type: c.tool,
          status: "pending_approval",
          reason: g.reason,
          item_id: c.item_id,
        });
        says.push("Held for Marie. " + g.reason);
      } else {
        step({
          key: "gate",
          label: "Allowed: " + describe(c),
          status: "ok",
          detail: g.rule + " · " + g.reason,
        });
        await wait(300);
        s = clone(mockState);
        applyCall(s, c, aid);
        s.trace = clone(trace);
        pushMock(s);
        ["Sign", "Menu", "Till"].forEach(function (t) {
          trace.steps.push({
            key: "target",
            label: t + " written",
            status: "ok",
          });
        });
        step({
          key: "verified",
          label: "Verified " + describe(c),
          status: "ok",
        });
        results.push({
          action_id: aid,
          type: c.tool,
          status: "verified",
          reason: null,
          item_id: c.item_id,
        });
        says.push(describe(c) + ".");
      }
      await wait(250);
    }
    var anyOk = results.some(function (r) {
      return r.status === "verified";
    });
    trace.say = (anyOk ? "Yes, chef. " : "") + says.join(" ");
    trace.done = true;
    s = clone(mockState);
    s.trace = clone(trace);
    pushMock(s);
    return { run_id: run_id, results: results, say: trace.say };
  }

  var MOCK_PHRASES = [
    "Two-for-one coffee until noon, and we're out of croissants.",
    "Muffins are twenty percent off until 3 pm.",
    "Latte is now $5.25.",
    "Croissants are back.",
  ];
  var mockPhraseIdx = 0;

  function mockRecord() {
    var text = "Two-for-one coffee until noon, and we're out of croissants.";
    function span(q) {
      var i = text.indexOf(q);
      return i < 0 ? null : [i, i + q.length];
    }
    var t0 = Date.now() - 60000;
    function ts(n) {
      return new Date(t0 + n * 900).toISOString();
    }
    var actor = {
      human_id: "usr_marie",
      role: "owner",
      agent_id: "agent_yeschef_v1",
    };
    var events = [
      "action.proposed",
      "policy.allowed",
      "target.applied",
      "target.applied",
      "target.applied",
      "action.verified",
    ];
    var details = [
      { type: "start_promo" },
      { rule_id: "owner_all", version: 1 },
      { target: "sign" },
      { target: "menu" },
      { target: "till" },
      { targets: 3 },
    ];
    var prev = "0".repeat(64);
    var audit = events.map(function (ev, i) {
      var h = (Math.abs(hashStr(prev + ev + i)).toString(16) + "a3f9c2e17b4d")
        .repeat(6)
        .slice(0, 64);
      var e = {
        shop_id: "shop_demo",
        seq: 41 + i,
        ts: ts(i),
        event: ev,
        action_id: "act_mock_promo",
        run_id: "run_mock1",
        actor: actor,
        detail: details[i],
        prev_hash: prev,
        hash: h,
      };
      prev = h;
      return e;
    });
    return {
      action: {
        _id: "act_mock_promo",
        shop_id: "shop_demo",
        run_id: "run_mock1",
        type: "start_promo",
        status: "verified",
        actor: actor,
        utterance: { text: text, lang: "en", stt: "elevenlabs" },
        evidence: [
          {
            field: "item",
            value: "coffee",
            quote: "coffee",
            span: span("coffee"),
            confidence: 0.98,
          },
          {
            field: "discount_pct",
            value: 50,
            quote: "Two-for-one",
            span: span("Two-for-one"),
            confidence: 0.95,
          },
          {
            field: "ends_at",
            value: "12:00",
            quote: "until noon",
            span: span("until noon"),
            confidence: 0.93,
          },
        ],
        params: {
          item_id: "item_coffee",
          discount_pct: 50,
          text_en: "Two for one",
          text_fr: "Deux pour un",
          ends_at: "12:00",
        },
        policy: {
          decision: "allow",
          rule_id: "owner_all",
          version: 1,
          reason: "Owners may change anything.",
          approved_by: null,
          approved_at: null,
        },
        targets: ["sign", "menu", "till"].map(function (n, i) {
          return {
            name: n,
            status: "verified",
            previous:
              n === "till"
                ? {
                    _id: "item_coffee",
                    price: 3.5,
                    available: true,
                    discount_pct: null,
                  }
                : {
                    _id: "item_coffee",
                    text_en: "Coffee",
                    text_fr: "Café",
                    price: 3.5,
                    sold_out: false,
                    promo_en: null,
                    promo_fr: null,
                    ends_at: null,
                  },
            applied_at: ts(2 + i),
            verified_at: ts(5),
          };
        }),
        undo_of: null,
        created_at: ts(0),
        updated_at: ts(5),
      },
      audit: audit,
      speaker_name: "Marie",
      item_name: "Coffee",
      chain: { ok: true, entries: 46, broken_at: null },
    };
  }
  function hashStr(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }
  function mockActions() {
    var now = Date.now();
    return [
      {
        _id: "act_mock_held",
        type: "start_promo",
        status: "pending_approval",
        actor: { human_id: "usr_sam", role: "employee" },
        utterance: { text: "Let's do twenty percent off muffins until close." },
        created_at: new Date(now - 20000).toISOString(),
      },
      {
        _id: "act_mock_price",
        type: "set_price",
        status: "blocked",
        actor: { human_id: "usr_sam", role: "employee" },
        utterance: { text: "Latte is now five dollars." },
        created_at: new Date(now - 40000).toISOString(),
      },
      {
        _id: "act_mock_soldout",
        type: "mark_sold_out",
        status: "verified",
        actor: { human_id: "usr_marie", role: "owner" },
        utterance: {
          text: "Two-for-one coffee until noon, and we're out of croissants.",
        },
        created_at: new Date(now - 60000).toISOString(),
      },
      {
        _id: "act_mock_promo",
        type: "start_promo",
        status: "verified",
        actor: { human_id: "usr_marie", role: "owner" },
        utterance: {
          text: "Two-for-one coffee until noon, and we're out of croissants.",
        },
        created_at: new Date(now - 60500).toISOString(),
      },
    ];
  }

  async function mockApi(path, body) {
    await wait(120);
    var p = path.split("?")[0];
    if (p === "/api/state") return clone(mockState);
    if (p === "/api/stt") {
      await wait(300);
      return { text: MOCK_PHRASES[mockPhraseIdx++ % MOCK_PHRASES.length] };
    }
    if (p === "/api/utterance") return mockUtterance(body);
    if (p === "/api/halt") {
      var s = clone(mockState);
      s.halted = !!body.halt;
      pushMock(s);
      return { halt: s.halted };
    }
    if (p === "/api/approve") {
      var s2 = clone(mockState),
        pend = s2.pending.filter(function (x) {
          return x.action_id === body.action_id;
        })[0];
      s2.pending = s2.pending.filter(function (x) {
        return x.action_id !== body.action_id;
      });
      var call =
        pend && pend._call
          ? pend._call
          : {
              tool: "start_promo",
              item_id: "item_muffin",
              discount_pct: 20,
              text_en: "20% off",
              text_fr: "20 % de rabais",
              ends_at: null,
            };
      if (body.approve) applyCall(s2, call, body.action_id);
      pushMock(s2);
      return body.approve
        ? { status: "verified", say: "Approved. " + describe(call) + "." }
        : { status: "rejected", say: "Rejected. Nothing changed." };
    }
    if (p === "/api/record") return mockRecord();
    if (p === "/api/actions") return mockActions();
    throw new Error("mock: no route " + p);
  }

  // ---------------------------------------------------------------- live API
  async function api(path, opts) {
    opts = opts || {};
    if (MOCK) return mockApi(path, opts.json);
    var headers = Object.assign({}, opts.headers || {});
    if (KEY) headers["x-key"] = KEY;
    var init = {
      method: opts.method || (opts.json || opts.body ? "POST" : "GET"),
      headers: headers,
    };
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(opts.json);
    } else if (opts.body !== undefined) init.body = opts.body;
    var r = await fetch(path, init);
    if (opts.raw) return r;
    var txt = await r.text();
    var data = null;
    try {
      data = txt ? JSON.parse(txt) : null;
    } catch (e) {
      data = { error: txt };
    }
    if (!r.ok) {
      var err = new Error(
        (data && (data.error || data.message)) || "HTTP " + r.status,
      );
      err.status = r.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /** connect(onState, onStatus): pushes ShopState to onState. onStatus("live"|"connecting"|"offline"|"mock"). */
  function connect(onState, onStatus) {
    onStatus = onStatus || function () {};
    if (MOCK) {
      listeners.push(onState);
      onStatus("mock");
      setTimeout(function () {
        onState(clone(mockState));
      }, 0);
      return;
    }
    var lastAt = 0;
    function deliver(s) {
      if (!s || typeof s !== "object") return;
      if (s.updatedAt && s.updatedAt < lastAt) return;
      lastAt = s.updatedAt || lastAt;
      onState(s);
    }
    api("/api/state")
      .then(deliver)
      .catch(function (e) {
        console.warn("GET /api/state failed", e);
      });
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var url = proto + "//" + location.host + "/agents/yes-chef-agent/shop_demo";
    function open() {
      onStatus("connecting");
      var ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        setTimeout(open, 1000);
        return;
      }
      ws.onopen = function () {
        onStatus("live");
      };
      ws.onmessage = function (ev) {
        var m;
        try {
          m = JSON.parse(ev.data);
        } catch (e) {
          return;
        }
        if (m && m.type === "cf_agent_state" && m.state) deliver(m.state);
      };
      ws.onclose = function () {
        onStatus("offline");
        setTimeout(open, 1000);
      };
      ws.onerror = function () {
        try {
          ws.close();
        } catch (e) {}
      };
    }
    open();
  }

  function itemNameFrom(state, id) {
    var s = ((state && state.sign) || []).filter(function (x) {
      return x.item_id === id;
    })[0];
    return s ? s.text_en : String(id || "").replace(/^item_/, "");
  }

  window.YC = {
    MOCK: MOCK,
    KEY: KEY,
    qs: qs,
    esc: esc,
    money: money,
    api: api,
    connect: connect,
    withMock: withMock,
    itemName: itemNameFrom,
    wait: wait,
  };
})();
