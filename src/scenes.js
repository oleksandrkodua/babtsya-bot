const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const replicas = (text, names) => {
  if (!names.length) return [];
  const who = [...names].sort((a, b) => b.length - a.length).map(esc).join("|");
  const re = new RegExp(`^(${who})(?:[ \\t]+«[^»\\n]*»)?(?:[ \\t]+\\([^\\n]*\\))?[ \\t]*:[ \\t]*(.+)$`, "gm");
  return [...text.matchAll(re)].map((m) => ({ speaker: m[1], raw: m[0], at: m.index }));
};
const enough = (lines) => lines.length >= 3 && new Set(lines.map((l) => l.speaker)).size >= 2;

export function playScenes(play, names) {
  const heads = [...play.matchAll(/^\(Сцена[ \t]+\d+\b[^\n]*/gm)];
  return heads.map((h, i) => {
    const start = h.index, bodyAt = start + h[0].length;
    const moral = play.indexOf("\nМораль:", bodyAt);
    const stop = Math.min(heads[i + 1]?.index ?? play.length, moral < 0 ? play.length : moral);
    const rest = play.slice(bodyAt, stop), lines = replicas(rest, names), last = lines.at(-1);
    // Trailing news, roll call and closing remarks belong to the play, outside editable dialogue.
    const end = bodyAt + (last ? last.at + last.raw.length : 0);
    return { id: i + 1, start, end, header: h[0], body: play.slice(bodyAt, end).trim(), lines };
  });
}

const numbers = (text) => [...new Set(text.match(/\d+(?:[.,]\d+)?/g) || [])].sort().join("|");
export function applySceneEdits(play, response, names) {
  let edits;
  try { edits = JSON.parse(response).edits; } catch { return play; }
  if (!Array.isArray(edits)) return play;
  const scenes = playScenes(play, names), accepted = new Map();
  for (const edit of edits) {
    const scene = scenes.find((s) => s.id === edit?.scene);
    if (!scene || accepted.has(scene.id) || typeof edit.text !== "string") continue;
    const text = edit.text.trim(), lines = replicas(text, names);
    const speakers = new Set(scene.lines.map((l) => l.speaker));
    if (!enough(lines) || text.length > scene.body.length + 400 || numbers(text) !== numbers(scene.body)
      || lines.some((l) => !speakers.has(l.speaker))
      || /^\(Сцена\b/m.test(text)
      || text.split("\n").some((l) => l.trim() && !l.startsWith("(") && !lines.some((r) => r.raw === l))) continue;
    accepted.set(scene.id, text);
  }
  for (const scene of scenes.reverse()) if (accepted.has(scene.id))
    play = play.slice(0, scene.start) + scene.header + "\n\n" + accepted.get(scene.id) + play.slice(scene.end);
  return play;
}

export function compactScenes(play, names) {
  const scenes = playScenes(play, names);
  for (const scene of scenes.reverse()) if (!enough(scene.lines)) {
    const title = scene.header.replace(/^\(Сцена[ \t]+\d+[.:]?[ \t]*/, "").replace(/[)\s]+$/, "");
    const remark = `(${[title, scene.body].filter(Boolean).join(" ").replace(/\s*\n\s*/g, " ")})`;
    play = play.slice(0, scene.start) + remark + play.slice(scene.end);
  }
  let n = 0;
  return play.replace(/^(\(Сцена[ \t]+)\d+\b/gm, (_, head) => `${head}${++n}`);
}
