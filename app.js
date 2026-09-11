/* Lifts — the phone side of the strength tracker, for the testing phase.
 *
 * Needs no server. The laptop packs the next few workouts into a link
 * (scripts/phone.py pack); this app keeps that plan, logs what actually
 * happened on this phone only, and sends it back as one block of text — by
 * email, or pasted straight into Claude Code (scripts/phone.py import).
 *
 * Everything lives in localStorage under one key. Sending never deletes
 * anything: the import is safe to run twice, so the report carries everything
 * logged since the laptop last read it, and a lost email costs a resend. Items
 * are only dropped once a new plan arrives saying the laptop has them.
 */

"use strict";

const STORE = "lifts:v1";
const BEGIN = "==LIFTS-RESULTS v1==";
const END = "==END==";
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const READINESS = ["", "Wrecked", "Tired", "Normal", "Good", "Great"];

/* ---------------------------------------------------------------- state */

function blank() {
  return { pack: null, sessions: {}, cardio: [], weighIns: [], lastSent: null, email: "" };
}

let state = (() => {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? { ...blank(), ...JSON.parse(raw) } : blank();
  } catch { return blank(); }
})();

function save() {
  try { localStorage.setItem(STORE, JSON.stringify(state)); }
  catch { toast("Couldn't save on this phone. Storage is full or blocked."); }
}

const ui = { tab: "train", session: null, machine: null, photos: [] };
try { ui.tab = sessionStorage.getItem("lifts:tab") || "train"; } catch { /* private mode */ }

/* ---------------------------------------------------------------- helpers */

/** Build an element. Text always goes in as text, never as HTML. */
function h(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "value") node.value = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

const pad = (n) => String(n).padStart(2, "0");
const isoLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (iso, n) => { const d = parseISO(iso); d.setDate(d.getDate() + n); return isoLocal(d); };
const nowISO = () => new Date().toISOString();

/** The training day, not the calendar day: before 04:00 it is still last
 *  night's session, so a workout that crosses midnight stays one workout. */
function trainingDate() {
  const hours = state.pack?.boundary_hour ?? 4;
  return isoLocal(new Date(Date.now() - hours * 3600e3));
}

function dayLabel(iso, short) {
  const d = parseISO(iso);
  return short ? `${WEEKDAYS[d.getDay()]} ${d.getDate()}`
               : `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
const timeText = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/** 150 -> "2½ min", 90 -> "90 s". */
function restText(seconds) {
  if (!seconds) return "—";
  if (seconds < 120) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  return seconds % 60 === 30 ? `${m}½ min` : `${m} min`;
}

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

let toastTimer = null;
function toast(message) {
  const t = document.getElementById("toast");
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

/* ---------------------------------------------------------------- codec */

/* JSON, gzipped, base64url. Survives an email client wrapping and quoting it:
   anything outside the alphabet is dropped before decoding, and gzip's own
   checksum catches anything actually damaged. The laptop side is phone.py. */

async function decodeCode(text) {
  const clean = String(text).replace(/[^A-Za-z0-9_-]/g, "");
  if (clean.length < 20) throw new Error("That code is too short. Copy all of it.");
  const b64 = clean.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (clean.length % 4)) % 4);
  let bytes;
  try { bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); }
  catch { throw new Error("That code is damaged. Copy it again, all of it."); }
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text());
  } catch { throw new Error("That code is damaged or cut short. Copy it again, all of it."); }
}

async function encodeObj(obj) {
  const stream = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* ---------------------------------------------------------------- the plan */

async function loadPack(text) {
  const raw = String(text || "").trim();
  const code = raw.includes("#p=") ? raw.slice(raw.indexOf("#p=") + 3) : raw;
  const pack = await decodeCode(code);
  if (!pack || pack.v !== 1 || !Array.isArray(pack.sessions)) throw new Error("That isn't a Lifts plan.");
  if (state.pack && state.pack.generated > pack.generated) {
    throw new Error("That plan is older than the one on this phone. Open the newest link.");
  }
  forgetImported(pack.imported_through);
  state.pack = pack;
  ui.session = null;
  save();
  return pack;
}

/** Drop what the laptop says it already has: everything last touched at or
 *  before the report it read. Anything newer stays and goes in the next one. */
function forgetImported(through) {
  if (!through) return;
  for (const [id, log] of Object.entries(state.sessions)) {
    if (log.touched && log.touched <= through) delete state.sessions[id];
  }
  state.cardio = state.cardio.filter((c) => c.at > through);
  state.weighIns = state.weighIns.filter((w) => w.at > through);
}

const findSession = (id) => state.pack?.sessions.find((s) => s.id === Number(id)) || null;

function defaultSession() {
  const today = trainingDate();
  const open = state.pack.sessions.filter((s) => !state.sessions[s.id]?.completed);
  return (open.find((s) => s.date >= today) || open[0] || state.pack.sessions.at(-1)).id;
}

function logFor(id, create) {
  let log = state.sessions[id];
  if (!log && create) {
    const plan = findSession(id);
    log = state.sessions[id] = {
      date: trainingDate(), label: plan?.label || "Workout", readiness: null,
      started: null, completed: null, notes: "", sets: {}, swaps: {}, touched: null,
    };
  }
  return log || null;
}

function touch(log) {
  log.touched = nowISO();
  if (!log.started) log.started = log.touched;
  save();
  refreshBadge();
}

function unsent() {
  const cut = state.lastSent || "";
  const logs = Object.values(state.sessions).filter((l) => (l.touched || "") > cut);
  return {
    sessions: logs.length,
    sets: logs.reduce((n, l) => n + Object.keys(l.sets).length, 0),
    cardio: state.cardio.filter((c) => c.at > cut).length,
    weighIns: state.weighIns.filter((w) => w.at > cut).length,
  };
}

function refreshBadge() {
  const u = unsent();
  const n = u.sessions + u.cardio + u.weighIns;
  const badge = document.getElementById("badge");
  badge.hidden = n === 0;
  badge.textContent = String(n);
}

/* ---------------------------------------------------------------- rest timer */

let timerEnd = null;
let timerTick = null;
let wakeLock = null;

async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* not allowed right now; the timer still works */ }
}

function startRest(seconds, label) {
  if (!seconds) return;
  timerEnd = Date.now() + seconds * 1000;
  document.getElementById("timer-label").textContent = label;
  const bar = document.getElementById("timer");
  bar.hidden = false;
  bar.classList.remove("over");
  document.body.classList.add("timing");
  clearInterval(timerTick);
  timerTick = setInterval(drawTimer, 250);
  drawTimer();
  keepAwake(true);
}

function drawTimer() {
  if (!timerEnd) return;
  const left = Math.round((timerEnd - Date.now()) / 1000);
  const t = Math.abs(left);
  document.getElementById("timer-clock").textContent =
    `${left < 0 ? "+" : ""}${Math.floor(t / 60)}:${pad(t % 60)}`;
  const bar = document.getElementById("timer");
  if (left <= 0 && !bar.classList.contains("over")) {
    bar.classList.add("over");
    document.getElementById("timer-label").textContent = "Rest done. Next set.";
    try { navigator.vibrate && navigator.vibrate([300, 150, 300]); } catch { /* unsupported */ }
  }
}

function stopRest() {
  clearInterval(timerTick);
  timerEnd = null;
  document.getElementById("timer").hidden = true;
  document.body.classList.remove("timing");
  keepAwake(false);
}

document.getElementById("timer-add").addEventListener("click", () => {
  if (timerEnd) { timerEnd += 30000; drawTimer(); }
});
document.getElementById("timer-stop").addEventListener("click", stopRest);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && timerEnd) { keepAwake(true); drawTimer(); }
});

/* ---------------------------------------------------------------- Train */

function header(eyebrow, title, goal) {
  return h("header", {},
    h("p", { class: "eyebrow", text: eyebrow }),
    h("h1", { text: title }),
    goal ? h("p", { class: "goal", text: goal }) : null);
}

function planHeader(p) {
  const b = p.block || {};
  return header(
    [b.macrocycle, b.phase && `${b.phase} phase`].filter(Boolean).join(" · ") || "Lifts",
    b.block ? `Block ${b.block} · Week ${b.week} of ${b.weeks}` : "Your plan",
    b.goal);
}

function weekStrip(p) {
  const today = trainingDate();
  const monday = addDays(today, -((parseISO(today).getDay() + 6) % 7));
  const cells = [];
  const toDo = [];
  const cardio = [];
  for (let k = 0; k < 7; k++) {
    const iso = addDays(monday, k);
    const known = (p.week || []).find((d) => d.date === iso);
    const sess = p.sessions.find((s) => s.date === iso);
    const doneHere = Object.values(state.sessions).some((l) => l.date === iso && l.completed);
    let plan = doneHere ? "done" : known ? known.plan : sess ? "lift" : "rest";
    if (plan === "in_progress") plan = "lift";
    if (plan === "lift" && iso < today) plan = "missed";
    if (plan === "lift") toDo.push(WEEKDAYS[parseISO(iso).getDay()]);
    const minutes = (p.cardio?.days || []).find((d) => d.date === iso)?.minutes || known?.cardio || 0;
    if (minutes && iso >= today) cardio.push(`${WEEKDAYS[parseISO(iso).getDay()]} ${minutes} min`);
    const letter = sess?.short || known?.label || "✓";
    cells.push(h("div", {
      class: `wd ${plan}${iso === today ? " today" : ""}`,
      "aria-label": `${dayLabel(iso)}${iso === today ? ", today" : ""}: ${plan === "lift" ? "weights" : plan}` +
        (minutes ? `, ${minutes} min cardio` : ""),
    },
      h("span", { class: "wd-name", text: WEEKDAYS[parseISO(iso).getDay()] }),
      h("div", { class: "wd-box", text: plan === "missed" ? "Miss" : ["lift", "done"].includes(plan) ? letter : "" }),
      h("span", { class: "wd-cardio", text: minutes ? `${minutes}′` : "" })));
  }
  const key = [toDo.length ? `Weights still to do: ${toDo.join(", ")}.` : "",
               cardio.length ? `Cardio (yellow): ${cardio.join(" · ")}.` : ""].join(" ").trim();
  return h("section", { "aria-label": "This week" },
    h("h2", { class: "label", text: "This week" }),
    h("div", { class: "week" }, cells),
    key ? h("p", { class: "week-key", text: key }) : null);
}

function picker(p) {
  const bar = h("div", { class: "picker", role: "tablist", "aria-label": "Workouts in this plan" });
  const today = trainingDate();
  for (const s of p.sessions) {
    const log = state.sessions[s.id];
    const status = log?.completed ? "Done ✓" : log?.touched ? "Started"
      : s.date === today ? "Tonight" : dayLabel(s.date, true);
    bar.append(h("button", {
      type: "button", role: "tab", class: log?.completed ? "done" : "",
      "aria-selected": String(s.id === ui.session),
      onclick: () => { ui.session = s.id; render(); window.scrollTo(0, 0); },
    }, h("b", { text: s.short ? `Day ${s.short}` : s.label }), h("span", { text: status })));
  }
  return bar;
}

function readiness(s) {
  const row = h("div", { class: "ready-row" });
  for (let n = 1; n <= 5; n++) {
    row.append(h("button", {
      type: "button", "aria-label": `${n}, ${READINESS[n]}`,
      onclick: () => { const log = logFor(s.id, true); log.readiness = n; touch(log); render(); },
    }, h("b", { text: String(n) }), h("span", { text: READINESS[n] })));
  }
  return h("div", { class: "ready" },
    h("p", { class: "ready-q", text: "How ready do you feel?" }), row,
    h("p", { class: "ready-why", text: "Two low scores in a row is one of the things that asks Claude to look at your plan." }));
}

/** The swap in force for an exercise. Older saves kept only an id. */
function currentSwap(log, e) {
  const raw = log?.swaps?.[e.id];
  if (!raw) return null;
  if (typeof raw === "number") return (e.swaps || []).find((x) => x.id === raw) || null;
  return raw;
}

/* The picker for "that machine is taken".
 *
 * A handful of suggestions is not enough on its own: the one machine free at
 * midnight may be nothing like the one in the plan. The whole library rides in
 * the pack, and anything the gym has that the library does not can be typed —
 * it joins your list on the laptop when the results are sent. */
function openSwap(s, e) {
  const lib = state.pack?.library || { exercises: [], muscles: [], body_parts: [], equipment: [] };
  const muscleName = (key) => lib.muscles.find((m) => m.key === key)?.name || key;

  const back = h("div", { class: "sheet-back" });
  const onKey = (ev) => { if (ev.key === "Escape") close(); };
  function close() { back.remove(); document.removeEventListener("keydown", onKey); }
  back.addEventListener("click", (ev) => { if (ev.target === back) close(); });
  document.addEventListener("keydown", onKey);

  const pick = (choice) => {
    const log = logFor(s.id, true);
    if (choice) log.swaps[e.id] = choice; else delete log.swaps[e.id];
    touch(log);
    close();
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
    toast(choice ? `Swapped to ${choice.name}.` : `Back to ${e.name}.`);
  };

  const list = h("div", { class: "sheet-list" });
  const item = (x, why) => h("button", {
    type: "button", class: "pick", onclick: () => pick({ id: x.id, name: x.name }),
  }, h("b", { text: x.name }), h("span", { text: why || muscleName(x.m) }));

  const draw = (query) => {
    list.replaceChildren();
    const q = query.trim().toLowerCase();
    if (!q) {
      if (currentSwap(state.sessions[s.id] || null, e)) {
        list.append(h("button", { type: "button", class: "pick", onclick: () => pick(null) },
          h("b", { text: `Back to ${e.name}` }), h("span", { text: "what the plan asked for" })));
      }
      if (e.swaps?.length) {
        list.append(h("p", { class: "label", text: "Closest to it" }));
        e.swaps.forEach((x) => list.append(item(x, "suggested")));
        list.append(h("p", { class: "label", text: "Everything on your list" }));
      }
    }
    const hits = lib.exercises.filter((x) => x.id !== e.id && (!q || x.name.toLowerCase().includes(q)));
    if (!hits.length) list.append(h("p", { class: "hint", text: "Nothing with that name. Add it below." }));
    hits.slice(0, 80).forEach((x) => list.append(item(x)));
    if (hits.length > 80) {
      list.append(h("p", { class: "hint", text: `${hits.length - 80} more. Keep typing to narrow it down.` }));
    }
  };

  const search = h("input", {
    type: "search", class: "input", placeholder: "Search your exercises",
    "aria-label": "Search exercises",
  });
  search.addEventListener("input", () => draw(search.value));

  const nameIn = h("input", { type: "text", class: "input", placeholder: "e.g. Hammer Strength Row",
    "aria-label": "Name of the exercise" });
  const muscleIn = h("select", { "aria-label": "Main muscle" });
  for (const bp of lib.body_parts) {
    const group = h("optgroup", { label: bp.name });
    bp.muscles.forEach((m) => group.append(h("option", { value: m, text: muscleName(m) })));
    muscleIn.append(group);
  }
  const kitIn = h("select", { "aria-label": "Kit" });
  lib.equipment.forEach((q) => kitIn.append(h("option", { value: q.key, text: q.name })));
  kitIn.value = "machine";
  const compoundIn = h("input", { type: "checkbox" });
  compoundIn.checked = true;

  const own = h("details", {}, h("summary", { text: "Not on the list? Add your own" }),
    h("div", { class: "own" },
      nameIn,
      h("div", { class: "grid2" },
        h("label", { class: "lbl" }, "Main muscle", muscleIn),
        h("label", { class: "lbl" }, "Kit", kitIn)),
      h("label", { class: "check" }, compoundIn,
        h("span", { text: "Works several muscles at once — a press, a row, a squat" })),
      h("p", { class: "hint", text: "It joins your exercise list on the laptop when you send your results." }),
      h("button", { type: "button", class: "btn", text: "Use this exercise", onclick: () => {
        const name = nameIn.value.trim();
        if (name.length < 2) { toast("Type the exercise's name first."); nameIn.focus(); return; }
        pick({ id: null, name, m: muscleIn.value, eq: kitIn.value, c: compoundIn.checked });
      } })));

  back.append(h("div", { class: "sheet", role: "dialog", "aria-modal": "true",
    "aria-label": `Instead of ${e.name}` },
    h("div", { class: "sheet-top" },
      h("h2", { class: "card-title", text: `Instead of ${e.name}` }),
      h("button", { type: "button", class: "chip", text: "Close", onclick: close })),
    search, list, own));
  document.body.append(back);
  draw("");
  search.focus();
}

function numberField(value, placeholder, step, label, unit) {
  const input = h("input", {
    type: "number", inputmode: step === "1" ? "numeric" : "decimal",
    step, min: "0", placeholder, "aria-label": label,
  });
  input.value = value;
  return [input, h("label", { class: "field" }, input, h("span", { text: unit }))];
}

function setRows(s, e, exId, name, swapped, lastExercise) {
  const box = h("div", { class: "sets" },
    h("div", { class: "set-grid set-head" },
      h("span", { text: "Set" }), h("span", { text: "Weight" }), h("span", { text: "Reps" }),
      h("span", { text: "Left" }), h("span")));
  const kgInputs = [];
  // An exercise typed in at the gym has no id yet, so its sets are kept under
  // its name until the laptop gives it one.
  const base = exId == null ? `c-${name.toLowerCase()}` : String(exId);

  e.sets.forEach((target, i) => {
    const key = `${base}:${i}`;
    const done = state.sessions[s.id]?.sets?.[key] || null;
    const [kgIn, kgBox] = numberField(done?.kg ?? "",
      swapped || target.kg == null ? "—" : String(target.kg), "0.5", `${name}, set ${i + 1}, weight`, "kg");
    const [repIn, repBox] = numberField(done?.reps ?? "", String(target.reps ?? ""), "1",
      `${name}, set ${i + 1}, reps`, "reps");
    kgInputs.push(kgIn);

    const rir = h("select", { class: "rir", "aria-label": `${name}, set ${i + 1}, reps left in the tank` });
    [0, 1, 2, 3, 4].forEach((n) => rir.append(h("option", { value: String(n), text: n === 4 ? "4+" : String(n) })));
    rir.value = String(done?.rir ?? target.rir ?? 2);

    const row = h("div", { class: `set-grid set-row${done ? " done" : ""}` });
    const tick = h("button", {
      type: "button", class: "tick", text: "✓",
      "aria-pressed": String(Boolean(done)), "aria-label": `${name}, set ${i + 1} done`,
    });

    tick.addEventListener("click", () => {
      const log = logFor(s.id, true);
      if (log.sets[key]) {
        delete log.sets[key];
        row.classList.remove("done");
        tick.setAttribute("aria-pressed", "false");
        touch(log);
        return;
      }
      // Ticking with the boxes empty means "done as written".
      const kg = num(kgIn.value) ?? num(kgIn.placeholder);
      const reps = num(repIn.value) ?? num(repIn.placeholder);
      if (kg === null || kg < 0) { toast("Type the weight first."); kgIn.focus(); return; }
      if (reps === null || reps <= 0) { toast("Type the reps first."); repIn.focus(); return; }
      if (!Object.keys(log.sets).length) log.date = trainingDate();
      kgIn.value = kg;
      repIn.value = Math.round(reps);
      log.sets[key] = { ex: exId, i, kg, reps: Math.round(reps), rir: Number(rir.value), name, at: nowISO() };
      row.classList.add("done");
      tick.setAttribute("aria-pressed", "true");
      touch(log);
      if (!(lastExercise && i === e.sets.length - 1)) {
        startRest(e.rest, `Rest · ${name}, set ${i + 1} done`);
      }
    });

    // Changing a set already ticked updates it.
    const update = () => {
      const log = state.sessions[s.id];
      const rec = log?.sets?.[key];
      if (!rec) return;
      const kg = num(kgIn.value);
      const reps = num(repIn.value);
      if (kg !== null && kg >= 0) rec.kg = kg;
      if (reps !== null && reps > 0) rec.reps = Math.round(reps);
      rec.rir = Number(rir.value);
      rec.at = nowISO();
      touch(log);
    };
    [kgIn, repIn, rir].forEach((x) => x.addEventListener("change", update));

    // The same weight usually runs down the exercise: fill the blank sets below.
    kgIn.addEventListener("change", () => {
      kgInputs.slice(i + 1).forEach((later) => { if (!later.value) later.value = kgIn.value; });
    });

    row.append(h("span", { class: "set-n", text: String(i + 1) }), kgBox, repBox, rir, tick);
    box.append(row);
  });
  return box;
}

function exerciseCard(s, e, i, total) {
  const log = state.sessions[s.id] || null;
  const swap = currentSwap(log, e);
  const exId = swap ? swap.id : e.id;
  const name = swap ? swap.name : e.name;
  const rir = e.sets[0]?.rir ?? 2;

  const card = h("article", { class: "ex", style: `--stripe: var(${e.compound ? "--plate-blue" : "--iso"})` });
  card.append(h("div", { class: "ex-top" },
    h("span", { class: "ex-n", text: String(i + 1) }),
    h("h3", { class: "ex-name", text: name }),
    h("span", { class: "kind", text: e.compound ? "Compound" : "Isolation" })));

  const reps = e.sets.map((x) => x.reps);
  const same = reps.every((r) => r === reps[0]);
  card.append(h("p", { class: "pres" },
    `${e.sets.length} × ${same ? reps[0] : reps.join("/")}`,
    h("span", { class: "rir", text: `stop with ${rir} left in the tank` })));

  const meta = h("div", { class: "ex-meta" },
    h("button", {
      type: "button", class: "chip", "aria-label": `Start ${restText(e.rest)} rest`,
      onclick: () => startRest(e.rest, `Rest · ${name}`),
    }, "Rest ", h("b", { text: restText(e.rest) })));
  const kg = swap ? null : e.sets[0]?.kg;
  if (kg) meta.append(h("span", { class: "chip" }, "Working ", h("b", { text: `${kg} kg` })));
  meta.append(h("button", {
    type: "button", class: "chip", text: swap ? "Change swap…" : "Machine taken? Swap…",
    onclick: () => openSwap(s, e),
  }));
  card.append(meta);

  if (swap) {
    card.append(h("p", { class: "reason",
      text: `In place of ${e.name}. Pick a weight you could lift for the reps with ${rir} left.` }));
  } else if (e.reason) {
    card.append(h("p", { class: "reason", text: e.reason }));
  }

  if (!swap && e.warmups?.length) {
    card.append(h("div", { class: "warm" },
      h("h4", { text: `Warm-up · ${restText(e.warmup_rest)} between` }),
      h("ol", {}, e.warmups.map((w) => h("li", {},
        h("b", { text: w.bar ? "Bar" : `${w.kg} kg` }),
        h("span", { text: `× ${w.reps} · ${w.pct}% of working` }))))));
  } else if (!swap && e.hint) {
    card.append(h("div", { class: "warm" }, h("h4", { text: "Warm-up" }), h("p", { text: e.hint })));
  }

  card.append(setRows(s, e, exId, name, Boolean(swap), i === total - 1));
  return card;
}

function finish(s) {
  const log = state.sessions[s.id] || null;
  if (log?.completed) {
    return h("div", { class: "finish" },
      h("p", {}, h("b", { text: `Finished at ${timeText(log.completed)}.` }), " Send your results from the Send tab."),
      h("button", {
        type: "button", class: "btn ghost", text: "Reopen workout",
        onclick: () => { log.completed = null; touch(log); render(); },
      }));
  }
  const notes = h("textarea", {
    rows: "2", "aria-label": "Notes on this workout",
    placeholder: "Anything worth knowing? Machine busy, knee niggle, slept badly…",
  });
  notes.value = log?.notes || "";
  notes.addEventListener("change", () => { const l = logFor(s.id, true); l.notes = notes.value.trim(); touch(l); });
  return h("div", { class: "finish" }, notes, h("button", {
    type: "button", class: "btn", text: "Finish workout",
    onclick: () => {
      const l = logFor(s.id, true);
      if (!Object.keys(l.sets).length && !confirm("No sets ticked. Finish anyway?")) return;
      l.notes = notes.value.trim();
      l.completed = nowISO();
      touch(l);
      stopRest();
      toast("Workout finished. Send your results when you're ready.");
      ui.tab = "send";
      render();
      window.scrollTo(0, 0);
    },
  }));
}

function sessionView(s) {
  const log = state.sessions[s.id] || null;
  const out = h("section", { class: "session", "aria-label": s.label },
    h("div", { class: "session-head" },
      h("h2", { class: "session-title", text: s.label }),
      h("span", { class: "session-date", text: `Planned ${dayLabel(s.date)}` })));
  if (s.flags?.length) {
    out.append(h("p", { class: "note warn" }, h("b", { text: "Flagged. " }), s.flags.join(" "),
      " Send your results afterwards and Claude will look at it."));
  }
  if (!log?.readiness && !log?.completed) out.append(readiness(s));
  else if (log?.readiness) out.append(h("p", { class: "feel", text: `Feeling ${log.readiness}/5 · ${READINESS[log.readiness]}` }));
  out.append(h("p", { class: "hint", text: "Tick a set when it's done. Ticking with the boxes empty means done exactly as written." }));
  s.exercises.forEach((e, i) => out.append(exerciseCard(s, e, i, s.exercises.length)));
  out.append(finish(s));
  return out;
}

function renderTrain(app) {
  const p = state.pack;
  if (!p) { app.append(welcome()); return; }
  app.append(planHeader(p), weekStrip(p));
  if (!p.sessions.length) {
    app.append(h("p", { class: "note", text: "No workouts in this plan. Ask Claude for a new link." }));
    return;
  }
  if (!ui.session || !findSession(ui.session)) ui.session = defaultSession();
  app.append(picker(p), sessionView(findSession(ui.session)));
}

/* ---------------------------------------------------------------- Cardio */

function lastBout(modality) {
  return [...state.cardio].reverse().find((b) => !modality || b.modality === modality) || null;
}

function settingText(m, b) {
  return (m?.settings || []).map((st) => (b?.[st.key] != null ? `${st.label} ${b[st.key]}${st.unit}` : null))
    .filter(Boolean).join(" · ");
}

function cardioForm(p) {
  const machines = p.machines || [];
  if (!ui.machine || !machines.some((m) => m.key === ui.machine)) {
    ui.machine = lastBout()?.modality || machines[0]?.key;
  }
  const m = machines.find((x) => x.key === ui.machine);
  const planned = (p.cardio?.days || []).find((d) => d.date === trainingDate());

  const machine = h("select", { name: "modality", "aria-label": "Machine",
    onchange: (ev) => { ui.machine = ev.target.value; form.replaceWith(cardioForm(p)); } });
  machines.forEach((x) => machine.append(h("option", { value: x.key, text: x.name })));
  machine.value = ui.machine;

  // What was set last time on this machine: on the phone if logged here since
  // the last plan, otherwise whatever the laptop has on record.
  const local = lastBout(ui.machine);
  const last = local ? settingText(m, local) : m?.last ? settingText(m, m.last) : "";
  const lastMinutes = local?.minutes ?? m?.last?.minutes;

  const fields = [
    h("label", { class: "lbl" }, "Day", h("input", { type: "date", name: "date", value: trainingDate() })),
    h("label", { class: "lbl" }, "Minutes",
      h("input", { type: "number", name: "minutes", inputmode: "decimal", min: "1", step: "1",
        placeholder: planned ? String(planned.minutes) : "20" })),
  ];
  for (const st of m?.settings || []) {
    fields.push(h("label", { class: "lbl" }, st.unit.trim() ? `${st.label} (${st.unit.trim()})` : st.label,
      h("input", { type: "number", name: st.key, inputmode: "decimal", step: String(st.step),
        min: String(st.low), max: String(st.high),
        placeholder: local?.[st.key] != null ? String(local[st.key]) : m?.last?.[st.key] != null ? String(m.last[st.key]) : "" })));
  }
  const effort = h("select", { name: "effort" });
  effort.append(h("option", { value: "", text: "—" }));
  for (let n = 1; n <= 10; n++) effort.append(h("option", { value: String(n), text: `${n}/10` }));
  const kind = h("select", { name: "kind" },
    h("option", { value: "steady", text: "Easy, steady" }),
    h("option", { value: "intervals", text: "Intervals" }));
  fields.push(h("label", { class: "lbl" }, "How hard", effort), h("label", { class: "lbl" }, "Type", kind),
    h("label", { class: "lbl" }, "Average heart rate",
      h("input", { type: "number", name: "avg_hr", inputmode: "numeric", min: "40", max: "220", placeholder: "optional" })));

  const form = h("form", { class: "card", "aria-label": "Log cardio" },
    h("h2", { class: "card-title", text: "Log cardio" }),
    h("label", { class: "lbl" }, "Machine", machine),
    m?.note ? h("p", { class: "hint", text: m.note }) : null,
    last || lastMinutes ? h("p", { class: "note yellow" }, h("b", { text: "Last time: " }),
      [lastMinutes ? `${lastMinutes} min` : "", last].filter(Boolean).join(" · "),
      ". Nudge one setting up if that felt easy.") : null,
    h("div", { class: "grid2" }, fields),
    h("textarea", { name: "notes", rows: "2", placeholder: "Notes (optional)", "aria-label": "Notes" }),
    h("button", { type: "submit", class: "btn", text: "Save cardio" }));

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const minutes = num(fd.get("minutes"));
    if (!minutes || minutes <= 0) { toast("Type how many minutes."); return; }
    const bout = {
      cid: `ph-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      date: fd.get("date") || trainingDate(), modality: m.key, name: m.name, minutes,
      kind: fd.get("kind") || "steady", effort: num(fd.get("effort")), avg_hr: num(fd.get("avg_hr")),
      notes: String(fd.get("notes") || "").trim() || null, at: nowISO(),
    };
    for (const st of m.settings || []) bout[st.key] = num(fd.get(st.key));
    state.cardio.push(bout);
    save();
    refreshBadge();
    toast(`Saved: ${minutes} min, ${m.name}.`);
    render();
  });
  return form;
}

function renderCardio(app) {
  const p = state.pack;
  if (!p) { app.append(welcome()); return; }
  const c = p.cardio;
  app.append(header("Cardio", "This week", c?.reason));

  if (c) {
    const end = addDays(c.week_start, 6);
    const local = state.cardio.filter((b) => b.date >= c.week_start && b.date <= end)
      .reduce((n, b) => n + b.minutes, 0);
    const done = Math.round((c.done_minutes || 0) + local);
    const share = Math.min(100, Math.round((done / Math.max(1, c.target_minutes)) * 100));
    const today = trainingDate();
    app.append(h("section", { class: "card", "aria-label": "Cardio so far" },
      h("p", { class: "big" }, String(done), h("small", { text: ` of ${c.target_minutes} min` })),
      h("div", { class: "meter", role: "img", "aria-label": `${share}% of this week's cardio done` },
        h("div", { style: `width:${share}%` })),
      c.zone2 ? h("p", { class: "hint", text: `Easy pace: heart rate ${c.zone2[0]}–${c.zone2[1]}. You could hold a conversation.` }) : null,
      h("ul", { class: "rows" }, c.days.filter((d) => d.date >= today).map((d) => h("li", {},
        h("div", { class: "main" },
          h("b", { text: `${dayLabel(d.date)} · ${d.minutes} min ${d.kind === "intervals" ? "intervals" : "easy"}` }),
          h("span", { text: `${d.when === "after_lifting" ? "After weights. " : "On its own. "}${d.guidance || ""}` })))))));
  }

  app.append(cardioForm(p));

  if (state.cardio.length) {
    app.append(h("section", { class: "card", "aria-label": "Cardio logged on this phone" },
      h("h2", { class: "card-title", text: "Logged on this phone" }),
      h("ul", { class: "rows" }, [...state.cardio].reverse().map((b) => {
        const m = (p.machines || []).find((x) => x.key === b.modality);
        return h("li", {},
          h("div", { class: "main" },
            h("b", { text: `${dayLabel(b.date)} · ${b.minutes} min ${b.name || b.modality}` }),
            h("span", { text: [settingText(m, b), b.effort ? `effort ${b.effort}/10` : ""].filter(Boolean).join(" · ") })),
          h("button", { type: "button", class: "x", "aria-label": "Delete this cardio", text: "✕",
            onclick: () => {
              if (!confirm("Delete this cardio?")) return;
              state.cardio = state.cardio.filter((x) => x.cid !== b.cid);
              save(); refreshBadge(); render();
            } }));
      }))));
  }
}

/* ---------------------------------------------------------------- Body */

function renderBody(app) {
  app.append(header("Body", "Weigh-in and photos"));

  const kg = h("input", { type: "number", name: "kg", inputmode: "decimal", step: "0.1", min: "30", max: "300",
    placeholder: state.pack?.block?.bodyweight ? String(state.pack.block.bodyweight) : "kg" });
  const on = h("input", { type: "date", name: "date", value: isoLocal(new Date()) });
  const note = h("input", { type: "text", name: "note", placeholder: "optional", class: "input" });
  const form = h("form", { class: "card", "aria-label": "Weigh-in" },
    h("h2", { class: "card-title", text: "Weigh-in" }),
    h("div", { class: "grid2" },
      h("label", { class: "lbl" }, "Weight (kg)", kg),
      h("label", { class: "lbl" }, "Day", on)),
    h("label", { class: "lbl" }, "Note", note),
    h("p", { class: "hint", text: "Same scales, first thing, after the toilet and before food. The trend matters, not one day." }),
    h("button", { type: "submit", class: "btn", text: "Save weigh-in" }));
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const w = num(kg.value);
    if (!w || w < 30 || w > 300) { toast("Type your weight in kg."); return; }
    // One weigh-in a day, as the tracker stores it: a second one replaces the first.
    state.weighIns = state.weighIns.filter((x) => x.date !== on.value);
    state.weighIns.push({ date: on.value, kg: w, note: note.value.trim() || null, at: nowISO() });
    save(); refreshBadge();
    toast(`Saved: ${w} kg.`);
    render();
  });
  app.append(form);

  if (state.weighIns.length) {
    app.append(h("section", { class: "card", "aria-label": "Weigh-ins on this phone" },
      h("h2", { class: "card-title", text: "Logged on this phone" }),
      h("ul", { class: "rows" }, [...state.weighIns].sort((a, b) => b.date.localeCompare(a.date)).map((w) =>
        h("li", {},
          h("div", { class: "main" }, h("b", { text: `${w.kg} kg` }), h("span", { text: dayLabel(w.date) })),
          h("button", { type: "button", class: "x", "aria-label": "Delete this weigh-in", text: "✕",
            onclick: () => {
              state.weighIns = state.weighIns.filter((x) => x !== w);
              save(); refreshBadge(); render();
            } }))))));
  }

  // Photos are not kept on the phone app: they go straight into the share
  // sheet as attachments. Claude reads them in the Claude Code conversation.
  const pick = h("input", { type: "file", accept: "image/*", multiple: true, "aria-label": "Choose progress photos" });
  const count = h("p", { class: "hint", text: ui.photos.length ? `${ui.photos.length} photo(s) ready.` : "No photos chosen yet." });
  pick.addEventListener("change", () => {
    ui.photos = [...pick.files];
    count.textContent = `${ui.photos.length} photo(s) ready.`;
  });
  const send = h("button", { type: "button", class: "btn", text: "Send photos", onclick: async () => {
    if (!ui.photos.length) { toast("Choose your photos first."); return; }
    const latest = [...state.weighIns].sort((a, b) => b.date.localeCompare(a.date))[0];
    const text = `Lifts progress photos · ${dayLabel(isoLocal(new Date()))}` +
      (latest ? ` · ${latest.kg} kg on ${dayLabel(latest.date)}` : "") +
      "\nFor Claude Code: please read these for the photo check-in.";
    if (navigator.canShare && navigator.canShare({ files: ui.photos })) {
      try {
        await navigator.share({ title: "Lifts progress photos", text, files: ui.photos });
        ui.photos = [];
        toast("Photos sent.");
        render();
      } catch { /* cancelled */ }
    } else {
      toast("This phone can't attach photos from here. Share them from the Gallery app instead.");
    }
  } });
  app.append(h("section", { class: "card", "aria-label": "Photo check-in" },
    h("h2", { class: "card-title", text: "Photo check-in" }),
    h("p", { class: "goal", text: "Four photos: front relaxed, side, back relaxed, back double biceps. Same spot, same light, same time of day as last time." }),
    pick, count, send,
    h("p", { class: "hint", text: "Send them to yourself, then share them into Claude Code. Claude reads them instead of the paid API while we test." })));
}

/* ---------------------------------------------------------------- Send */

function collect() {
  return {
    v: 1,
    pack: state.pack?.generated ?? null,
    sent: nowISO(),
    sessions: Object.entries(state.sessions)
      .filter(([, l]) => Object.keys(l.sets).length || l.completed || l.readiness)
      .map(([id, l]) => ({
        id: Number(id), label: l.label, date: l.date, readiness: l.readiness,
        started: l.started, completed: l.completed, notes: l.notes || null,
        sets: Object.values(l.sets).map(({ ex, i, kg, reps, rir, at, name }) => ({ ex, i, kg, reps, rir, at, name })),
      })),
    cardio: state.cardio.map(({ at, ...b }) => b),
    weigh_ins: state.weighIns.map(({ at, ...w }) => w),
    // Exercises typed in at the gym, for the laptop to put on the list.
    customs: Object.values(state.sessions)
      .flatMap((l) => Object.values(l.swaps || {}))
      .filter((x) => x && typeof x === "object" && x.id === null)
      .filter((x, i, all) => all.findIndex((y) => y.name === x.name) === i)
      .map(({ name, m, eq, c }) => ({ name, m, eq, c })),
  };
}

function summaryLines(data) {
  const lines = [];
  for (const s of data.sessions) {
    lines.push("", `${(s.label || "Workout").toUpperCase()} · ${s.date ? dayLabel(s.date) : ""}` +
      `${s.completed ? ` · finished ${timeText(s.completed)}` : " · not finished"}` +
      `${s.readiness ? ` · feeling ${s.readiness}/5` : ""}`);
    const byEx = new Map();
    for (const set of [...s.sets].sort((a, b) => a.at.localeCompare(b.at))) {
      if (!byEx.has(set.ex)) byEx.set(set.ex, []);
      byEx.get(set.ex).push(set);
    }
    for (const sets of byEx.values()) {
      sets.sort((a, b) => a.i - b.i);
      lines.push(`  ${sets[0].name}: ` + sets.map((x) => `${x.kg}×${x.reps} (${x.rir} left)`).join(", "));
    }
    if (s.notes) lines.push(`  Notes: ${s.notes}`);
  }
  if (data.cardio.length) {
    lines.push("", "CARDIO");
    for (const b of data.cardio) {
      const m = (state.pack?.machines || []).find((x) => x.key === b.modality);
      lines.push(`  ${dayLabel(b.date)} · ${b.name || b.modality} ${b.minutes} min` +
        [settingText(m, b), b.effort ? `effort ${b.effort}/10` : "", b.avg_hr ? `HR ${b.avg_hr}` : ""]
          .filter(Boolean).map((x) => ` · ${x}`).join(""));
    }
  }
  if (data.weigh_ins.length) {
    lines.push("", "WEIGH-INS");
    for (const w of data.weigh_ins) lines.push(`  ${dayLabel(w.date)} · ${w.kg} kg${w.note ? ` · ${w.note}` : ""}`);
  }
  return lines;
}

async function buildReport() {
  const data = collect();
  const code = await encodeObj(data);
  const wrapped = code.match(/.{1,76}/g) || [];
  const text = [
    `Lifts results · ${dayLabel(isoLocal(new Date()))} ${timeText(data.sent)}`,
    ...summaryLines(data),
    "",
    "Paste this whole message into Claude Code. The block below is the data.",
    "Sending it more than once is fine: nothing gets counted twice.",
    BEGIN, ...wrapped, END,
  ].join("\n");
  return { text, data };
}

function markSent(data) {
  state.lastSent = data.sent;
  save();
  refreshBadge();
}

function renderSend(app) {
  app.append(header("Send", "Results for Claude",
    "Email them to yourself, then paste the whole email into Claude Code. Claude loads them on the laptop and sends back your next plan."));

  const u = unsent();
  const any = Object.keys(state.sessions).length || state.cardio.length || state.weighIns.length;
  app.append(h("section", { class: "card", "aria-label": "Not sent yet" },
    h("h2", { class: "label", text: "Not sent yet" }),
    h("div", { class: "tally" },
      h("div", {}, h("b", { text: String(u.sets) }), h("span", { text: "sets" })),
      h("div", {}, h("b", { text: String(u.sessions) }), h("span", { text: "workouts" })),
      h("div", {}, h("b", { text: String(u.cardio) }), h("span", { text: "cardio" })),
      h("div", {}, h("b", { text: String(u.weighIns) }), h("span", { text: "weigh-ins" }))),
    state.lastSent ? h("p", { class: "hint", text: `Last sent ${dayLabel(isoLocal(new Date(state.lastSent)))} at ${timeText(state.lastSent)}.` }) : null));

  if (!any) {
    app.append(h("p", { class: "note", text: "Nothing logged yet. Train, log cardio or weigh in, and it shows up here." }));
  } else {
    const email = h("input", { type: "email", class: "input", autocomplete: "email", inputmode: "email",
      placeholder: "you@example.com", "aria-label": "Your email address", value: state.email || "" });
    email.addEventListener("change", () => { state.email = email.value.trim(); save(); });
    const preview = h("pre", { class: "report", text: "Building…" });
    const reportPromise = buildReport();
    reportPromise.then(({ text }) => { preview.textContent = text; });

    const emailBtn = h("button", { type: "button", class: "btn", text: "Email to me", onclick: async () => {
      state.email = email.value.trim(); save();
      if (!state.email) { toast("Type your email address first."); email.focus(); return; }
      const { text, data } = await buildReport();
      markSent(data);
      location.href = `mailto:${encodeURIComponent(state.email)}` +
        `?subject=${encodeURIComponent(`Lifts results ${dayLabel(isoLocal(new Date()))}`)}` +
        `&body=${encodeURIComponent(text)}`;
    } });
    const shareBtn = h("button", { type: "button", class: "btn ghost", text: "Share…", onclick: async () => {
      const { text, data } = await buildReport();
      if (!navigator.share) { toast("Sharing isn't available here. Use Copy instead."); return; }
      try {
        await navigator.share({ title: "Lifts results", text });
        markSent(data);
        render();
      } catch { /* cancelled */ }
    } });
    const copyBtn = h("button", { type: "button", class: "btn ghost", text: "Copy", onclick: async () => {
      const { text, data } = await buildReport();
      try {
        await navigator.clipboard.writeText(text);
        markSent(data);
        toast("Copied. Paste it into an email or into Claude Code.");
        render();
      } catch { toast("Couldn't copy. Open “See what gets sent” and copy it by hand."); }
    } });

    app.append(h("section", { class: "card", "aria-label": "Send results" },
      h("label", { class: "lbl" }, "Your email address (kept on this phone only)", email),
      emailBtn,
      h("div", { class: "btn-row" }, shareBtn, copyBtn),
      h("details", {}, h("summary", { text: "See what gets sent" }), preview)));
  }

  const p = state.pack;
  app.append(h("section", { class: "card", "aria-label": "Plan on this phone" },
    h("h2", { class: "card-title", text: "Plan on this phone" }),
    h("p", { class: "goal", text: p
      ? `Made ${dayLabel(p.generated.slice(0, 10))} at ${timeText(p.generated)} · ${p.sessions.length} workouts.`
      : "No plan yet." }),
    h("p", { class: "hint", text: "New link from Claude? Tap it and it loads here, or paste it below." }),
    loader()));
}

/* ---------------------------------------------------------------- shell */

function loader() {
  const ta = h("textarea", { rows: "3", placeholder: "Paste the plan link here", "aria-label": "Plan link" });
  const btn = h("button", { type: "button", class: "btn", text: "Load plan", onclick: async () => {
    try {
      const p = await loadPack(ta.value);
      toast(`Plan loaded: ${p.sessions.length} workouts.`);
      ui.tab = "train";
      render();
      window.scrollTo(0, 0);
    } catch (e) { toast(e.message); }
  } });
  return h("div", { class: "loader" }, ta, btn);
}

function welcome() {
  return h("section", { class: "welcome" },
    h("p", { class: "eyebrow", text: "Lifts" }),
    h("h1", { text: "No plan on this phone yet" }),
    h("p", { class: "goal", text: "Open the plan link Claude gives you and it loads here. Or paste the link below." }),
    loader());
}

function render() {
  const app = document.getElementById("app");
  app.replaceChildren();
  document.querySelectorAll("#tabs button").forEach((b) =>
    b.setAttribute("aria-current", b.dataset.tab === ui.tab ? "page" : "false"));
  refreshBadge();
  ({ train: renderTrain, cardio: renderCardio, body: renderBody, send: renderSend }[ui.tab] || renderTrain)(app);
}

document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => {
  ui.tab = b.dataset.tab;
  try { sessionStorage.setItem("lifts:tab", ui.tab); } catch { /* private mode */ }
  render();
  window.scrollTo(0, 0);
}));

/** A plan arrives as a link: https://…/#p=CODE. The code is in the fragment,
 *  which browsers never send to the server, so the site only ever serves code
 *  and your numbers go straight from the link into this phone. */
async function takePackFromLink() {
  if (!location.hash.startsWith("#p=")) return;
  try {
    const p = await loadPack(location.hash);
    ui.tab = "train";
    toast(`New plan loaded: ${p.sessions.length} workouts.`);
  } catch (e) { toast(e.message); }
  history.replaceState(null, "", location.pathname + location.search);
}

window.addEventListener("hashchange", async () => { await takePackFromLink(); render(); });

(async () => {
  await takePackFromLink();
  render();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
})();
