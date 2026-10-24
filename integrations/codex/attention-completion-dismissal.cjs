// Completion acknowledgements span independent background hook processes.
// Persist identifiers and hashes only, never message text.
const fs = require("fs");
const path = require("path");
const { createHash, randomUUID } = require("crypto");
const memory = new Map();
const hash = value => createHash("sha256").update(value).digest("hex");
const completionId = (session, turn) => "completion-" + hash(JSON.stringify([session, turn]));
const validText = value => typeof value === "string" && value.trim() && value.length <= 256 * 1024;
const validId = value => typeof value === "string" && /^completion-[a-f0-9]{64}$/.test(value);

function stateFor(session, options) {
  const key = hash(JSON.stringify([options.endpoint || "http://127.0.0.1:22222", session]));
  if (!options.completionStateDirectory) {
    if (!memory.has(key)) memory.set(key, new Map());
    const files = memory.get(key);
    return {
      get: name => files.get(name),
      put: (name, value) => { if (!files.has(name)) files.set(name, value); },
      completions: () => [...files.keys()].filter(validId).map(name => files.get(name)),
    };
  }
  const directory = path.join(options.completionStateDirectory, key);
  fs.mkdirSync(directory, { recursive: true });
  const get = name => {
    try { return JSON.parse(fs.readFileSync(path.join(directory, name + ".json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  };
  return {
    get,
    put: (name, value) => {
      if (get(name) !== undefined) return;
      const temporary = path.join(directory, "writing-" + randomUUID());
      fs.writeFileSync(temporary, JSON.stringify(value), { flag: "wx" });
      // First writer wins, with complete JSON visible atomically. Staging
      // files are retained alongside the metadata; no history is deleted.
      try { fs.linkSync(temporary, path.join(directory, name + ".json")); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    },
    completions: () => fs.readdirSync(directory).filter(name => /^completion-[a-f0-9]{64}\.json$/.test(name))
      .map(name => get(name.slice(0, -5))),
  };
}

function rememberCompletion(event, item, options, observedAt) {
  const state = stateFor(event.session_id, options);
  state.put(item.id, { id: item.id, observedAt });
  return { state, id: item.id };
}

const isAcknowledged = record => record.state.get("ack-" + record.id) === true;
async function resolveCompletion(record, options, dismiss) {
  const { state, id } = record;
  if (!isAcknowledged(record) || state.get("resolved-" + id)) return false;
  if (!await dismiss({ source: "codex", id }, options)) return false;
  state.put("resolved-" + id, true);
  return true;
}

async function acknowledgeCompletions(event, options, list, dismiss, observedAt) {
  if (event?.hook_event_name !== "UserPromptSubmit" ||
      ![event.session_id, event.turn_id, event.prompt].every(validText)) return 0;
  const state = stateFor(event.session_id, options);
  const ownCompletion = completionId(event.session_id, event.turn_id);
  const promptKey = "prompt-" + hash(JSON.stringify([event.turn_id, event.prompt]));
  // This timestamp and target set survive retries of the same submission.
  state.put(promptKey + "-time", observedAt);
  const cutoff = state.get(promptKey + "-time");
  const deadline = Date.now() + (options.timeoutMs || 1500);
  const bounded = () => {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new Error("Completion dismissal timed out");
    return { ...options, timeoutMs };
  };
  let targets = state.get(promptKey);
  if (!targets) {
    const items = await list(bounded());
    const known = new Set(items.filter(item => item?.source === "codex").map(item => item.id));
    const ids = items.filter(item => item?.source === "codex" && item.codexSessionId === event.session_id &&
      validId(item.id) && item.id !== ownCompletion && ["pending", "snoozed"].includes(item.state) &&
      Number.isSafeInteger(item.createdAt) && item.createdAt <= cutoff).map(item => item.id);
    // A Stop hook can still be waiting for origin discovery / its HTTP PUT.
    // Mark that ID now; creation checks the marker again after delivery.
    for (const record of state.completions()) {
      if (validId(record?.id) && record.id !== ownCompletion && !known.has(record.id) &&
          Number.isSafeInteger(record.observedAt) && record.observedAt <= cutoff) ids.push(record.id);
    }
    state.put(promptKey, [...new Set(ids)]);
    targets = state.get(promptKey);
  }
  for (const id of targets) state.put("ack-" + id, true);
  const results = await Promise.allSettled(targets.map(async id => resolveCompletion({ state, id }, bounded(), dismiss)));
  const failure = results.find(result => result.status === "rejected");
  if (failure) throw failure.reason;
  return results.filter(result => result.value === true).length;
}

module.exports = { rememberCompletion, isAcknowledged, resolveCompletion, acknowledgeCompletions };
