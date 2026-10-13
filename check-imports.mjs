// index.js imports from pipeline.js are not loaded by the self-check (it needs wrangler's text imports), so a removed export
// only failed at `wrangler deploy` (13.10.2026, gifMinute). Cheap guard: every imported name must be exported.
import { readFileSync } from "node:fs";
const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
const exported = new Set([...read("src/pipeline.js").matchAll(/^export (?:async )?(?:function|const|let|class)\s+([\w$]+)/gm)].map((m) => m[1]));
const imported = read("src/index.js").match(/import \{([^}]*)\} from "\.\/pipeline\.js"/)[1].split(",").map((n) => n.trim()).filter(Boolean);
const missing = imported.filter((n) => !exported.has(n));
if (missing.length) { console.error(`index.js імпортує з pipeline.js те, чого там нема: ${missing.join(", ")}`); process.exit(1); }
