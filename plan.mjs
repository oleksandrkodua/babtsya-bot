// A day's timeline from due() — the same function the cron runs on: `node plan.mjs 2026-10-01`.
// Runtime guards are not simulated: plays need ≥50 new messages, a grumble skips 14:00 after the midday play,
// the meat stock refills only while short.
import { due } from "./src/pipeline.js";
const day = process.argv[2] || new Date().toISOString().slice(0, 10);
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
let quiet = 0;
for (let m = 0; m < 1440; m += 30) {
  const d = due(day, m);
  if (d[0] === "тиша") { quiet++; continue; }
  if (quiet) { console.log(`до ${hm(m)}  тиша: ні постів, ні відповідей`); quiet = 0; }
  if (d.length) console.log(`${hm(m)}  ${d.join(" · ")}`);
}
