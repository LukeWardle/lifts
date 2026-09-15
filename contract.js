/* The offline plan-link contract. Keep this dependency-free: it is loaded before
 * app.js and is also executed by phone/tests/contract.test.mjs in Node. */
(function (root) {
  "use strict";

  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const MAX_PLAN_CODE_CHARS = 200_000;
  const MAX_PLAN_JSON_BYTES = 1_000_000;
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const fail = (message) => { throw new Error(`That plan is invalid: ${message}`); };
  const integer = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;
  const number = (value, low, high) => typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;

  function date(value, field) {
    const parsed = typeof value === "string" && DATE.test(value)
      ? new Date(`${value}T00:00:00Z`) : null;
    if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      fail(`${field} must be an ISO date`);
    }
  }

  function cardio(cardioPlan, field) {
    if (!isObject(cardioPlan)) fail(`${field} must be an object`);
    date(cardioPlan.week_start, `${field}.week_start`);
    if (!integer(cardioPlan.target_minutes, 0, 300)) fail(`${field}.target_minutes is out of range`);
    if (!Array.isArray(cardioPlan.days)) fail(`${field}.days must be an array`);
    const seen = new Set();
    for (const [index, day] of cardioPlan.days.entries()) {
      if (!isObject(day)) fail(`${field}.days[${index}] must be an object`);
      date(day.date, `${field}.days[${index}].date`);
      if (!integer(day.minutes, 1, 300)) fail(`${field}.days[${index}].minutes is out of range`);
      if (!["steady", "intervals", "conditioning"].includes(day.kind)) fail(`${field}.days[${index}].kind is unknown`);
      if (!["after_lifting", "standalone"].includes(day.when)) fail(`${field}.days[${index}].when is unknown`);
      if (seen.has(day.date)) fail(`${field}.days contains the same date twice`);
      seen.add(day.date);
    }
  }

  function validatePack(pack) {
    if (!isObject(pack) || pack.v !== 1 || !Array.isArray(pack.sessions)) {
      fail("it is not a recognised Lifts plan");
    }
    const sessions = new Set();
    for (const [index, session] of pack.sessions.entries()) {
      if (!isObject(session) || !integer(session.id, 1, Number.MAX_SAFE_INTEGER)) fail(`sessions[${index}].id is invalid`);
      if (sessions.has(session.id)) fail("two sessions have the same id");
      sessions.add(session.id);
      date(session.date, `sessions[${index}].date`);
      if (typeof session.label !== "string" || !session.label.trim() || session.label.length > 120) fail(`sessions[${index}].label is invalid`);
      if (!Array.isArray(session.exercises) || !session.exercises.length) fail(`sessions[${index}].exercises is empty`);
      for (const [exerciseIndex, exercise] of session.exercises.entries()) {
        if (!isObject(exercise) || !integer(exercise.id, 1, Number.MAX_SAFE_INTEGER)) fail(`sessions[${index}].exercises[${exerciseIndex}].id is invalid`);
        if (typeof exercise.name !== "string" || !exercise.name.trim() || exercise.name.length > 160) fail(`sessions[${index}].exercises[${exerciseIndex}].name is invalid`);
        if (!Array.isArray(exercise.sets) || !exercise.sets.length || exercise.sets.length > 50) fail(`sessions[${index}].exercises[${exerciseIndex}].sets is invalid`);
        for (const target of exercise.sets) {
          if (!isObject(target) || !integer(target.reps, 1, 100) || !integer(target.rir, 0, 10)
              || !(target.kg === null || number(target.kg, 0, 1000))) fail(`sessions[${index}] has an invalid set target`);
        }
      }
    }
    if (pack.cardio != null) cardio(pack.cardio, "cardio");
    if (pack.cardio_weeks != null) {
      if (!Array.isArray(pack.cardio_weeks)) fail("cardio_weeks must be an array");
      const weeks = new Set();
      for (const [index, item] of pack.cardio_weeks.entries()) {
        cardio(item, `cardio_weeks[${index}]`);
        if (weeks.has(item.week_start)) fail("cardio_weeks contains the same week twice");
        weeks.add(item.week_start);
      }
    }
    return pack;
  }

  async function decodePlanCode(text) {
    const clean = String(text).replace(/[^A-Za-z0-9_-]/g, "");
    if (clean.length < 20) throw new Error("That code is too short. Copy all of it.");
    if (clean.length > MAX_PLAN_CODE_CHARS) throw new Error("That plan is too large to load safely.");
    const b64 = clean.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (clean.length % 4)) % 4);
    let bytes;
    try { bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); }
    catch { throw new Error("That code is damaged. Copy it again, all of it."); }
    try {
      const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_PLAN_JSON_BYTES) {
          await reader.cancel();
          throw new Error("That plan expands beyond the safe size limit.");
        }
        chunks.push(value);
      }
      const joined = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder().decode(joined));
    } catch (error) {
      if (error?.message?.includes("safe size limit")) throw error;
      throw new Error("That code is damaged or cut short. Copy it again, all of it.");
    }
  }

  root.LiftsContract = Object.freeze({ validatePack, decodePlanCode });
})(globalThis);
