// Бабця з альтанки — Cloudflare Worker: Telegram webhook in, hourly digest out.
import analyzePrompt from "../prompts/analyze.txt";
import writePrompt from "../prompts/write.txt";
import polishPrompt from "../prompts/polish.txt";
import grumblesText from "../prompts/grumbles.txt";
import replyPrompt from "../prompts/reply.txt";
import grumblePrompt from "../prompts/grumble.txt";
import {
  BIG_DAY, BOT_NAME, HARD_LIMIT, applyFixes, castFix, castClean, rollCall, dedupLoop, finalize, lengthTarget, messageText,
  GRUMBLE_SLOTS, grumbleSection, parseGrumbles, addressesBot, dropName, tidy, mentionPrefix, REPLY_MOVES, REPLY_TONES, RUDE_SHARE, IMAGES, stripHints, femaleSet, isFemale, genderLine, topicFor, fixedReply, prevContext, neighbourMinute, splitChunks, warFallback, warWords, withoutReposts,
} from "./pipeline.js";
import { OPTIONS, QUESTION } from "../poll.js";

const MODEL = "@cf/google/gemma-4-26b-a4b-it";
const WRITER_TEMP = 1.15; // chosen 23.09.2026 after A/B on the test stand
const MIDDAY_MIN = 50; // midday runs only at 13:00 Kyiv (24.09.2026: a 15:30 surprise play starved the evening one)
const MIDDAY_MINUTE = 13 * 60; // ponytail: one shot, no retry — if it fails, the day rolls into the evening digest
const EVENING_MIN = 50; // below it the evening is skipped and messages roll into the next digest
const GRUMBLES = parseGrumbles(grumblesText);
const POLL_MINUTE = 21 * 60; // «зрада чи перемога» at 21:00 Kyiv
const STUB = `${BOT_NAME} сьогодні охрипла й мовчить. Завтра розкаже вдвічі більше.`;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const authorized = req.headers.get("X-Telegram-Bot-Api-Secret-Token") === env.WEBHOOK_SECRET;
    if (req.method === "POST" && url.pathname === "/telegram") {
      if (!authorized) return new Response("forbidden", { status: 403 });
      await ingest(env, await req.json(), ctx);
      return new Response("ok");
    }
    // Manual digest for test mode: same secret header, so only you can trigger it.
    if (req.method === "POST" && url.pathname === "/run") {
      if (!authorized) return new Response("forbidden", { status: 403 });
      const kind = url.searchParams.get("kind") || "manual";
      // ?kind=grumble[&s=тиша][&to=group] sends one grumble now; to=group skips TEST_MODE for a one-off post.
      const toGroup = url.searchParams.get("to") === "group";
      if (kind === "grumble") return new Response(await grumble(env, new Date(), url.searchParams.get("s"), toGroup));
      // ?kind=say&text=…[&reply=<message id>][&tag=Name1,Name2] — the bot says your text, as a reply if given,
      // opening with real tags of those names (ids come from the people table, filled by their messages).
      if (kind === "say") {
        const text = url.searchParams.get("text"), reply = Number(url.searchParams.get("reply"));
        if (!text) return new Response("say: нема text", { status: 400 });
        const names = (url.searchParams.get("tag") || "").split(",").map((n) => n.trim()).filter(Boolean);
        const { results: known } = names.length
          ? await env.DB.prepare(`SELECT name, uid FROM people WHERE name IN (${names.map(() => "?").join(",")})`).bind(...names).all()
          : { results: [] };
        const people = names.map((n) => known.find((k) => k.name === n)).filter(Boolean);
        const prefix = mentionPrefix(people);
        await telegram(env, "sendMessage", {
          chat_id: target(env, toGroup), text: prefix.text + text, entities: prefix.entities,
          ...(reply && { reply_parameters: { message_id: reply, allow_sending_without_reply: true } }),
        });
        const missing = names.filter((n) => !people.some((p) => p.name === n));
        return new Response(`say: ${prefix.text}${text}${missing.length ? `\nбез тегу (ще не писали після оновлення): ${missing.join(", ")}` : ""}`);
      }
      // ?kind=sample&text=…[&name=…][&t=0.6,0.8,1.0][&n=2] — replies at each temperature, returned here, never sent.
      if (kind === "sample") {
        const text = url.searchParams.get("text") || "", name = url.searchParams.get("name") || "Ivan M";
        const temps = (url.searchParams.get("t") || "0.6,0.8,1.0").split(",").map(Number).filter((t) => t >= 0 && t <= 2).slice(0, 4);
        const n = Math.min(Number(url.searchParams.get("n")) || 2, 3);
        const out = [];
        for (const t of temps) for (let i = 0; i < n; i++) {
          const r = await compose(env, name, text, "", t);
          out.push(`t=${t} (${r.tone}): ${r.text || "—"}`);
        }
        return new Response(out.join("\n"));
      }
      // ?kind=poll[&to=group] — one poll now, same as the 21:00 one.
      if (kind === "poll") return new Response(await poll(env, toGroup));
      const { day } = kyiv(new Date());
      // &keep=1 — a preview: messages stay in the base and the digest isn't recorded, so the real one still covers the day.
      return new Response(await digest(env, day, kind, url.searchParams.get("keep") === "1"));
    }
    return new Response(BOT_NAME);
  },

  async scheduled(controller, env) {
    const now = new Date(controller.scheduledTime); // cron runs at :00 and :30
    const { day, hour } = kyiv(now);
    const pending = () => env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE ts < ?").bind(Math.floor(now / 1000)).first("n");
    const done = (kind) => env.DB.prepare("SELECT 1 FROM digests WHERE day = ? AND kind = ?").bind(day, kind).first();
    let posted = false;
    if (slotMinute(now) === MIDDAY_MINUTE && !(await done("midday")) && (await pending()) >= MIDDAY_MIN) {
      console.log(await digest(env, day, "midday"));
      posted = true;
    }
    if (hour >= 22 && !(await done("evening")) && (await pending()) >= EVENING_MIN) {
      console.log(await digest(env, day, "evening"));
      posted = true;
    }
    // A grumble right under a fresh digest would bury it.
    if (!posted && GRUMBLE_SLOTS.includes(slotMinute(now))) console.log(await grumble(env, now));
    if (slotMinute(now) === neighbourMinute(day)) console.log(await grumble(env, now, "сусід"));
    if (slotMinute(now) === POLL_MINUTE) console.log(await poll(env));
  },
};

async function ingest(env, update, ctx) {
  const msg = update.message || update.edited_message;
  // Anonymous admins arrive from GroupAnonymousBot (is_bot) with sender_chat set — keep those.
  if (!msg || (msg.from?.is_bot && !msg.sender_chat)) return;
  if (String(msg.chat?.id) !== env.GROUP_CHAT_ID) {
    // After the webhook is set getUpdates stops working; this is how a new group's id shows up in `wrangler tail`.
    console.log(`Чужий чат: ${msg.chat?.id} ${msg.chat?.type} ${msg.chat?.title || ""}`);
    return;
  }
  const raw = msg.text || msg.caption || "";
  const who = (m) => (m.sender_chat?.id === m.chat?.id ? "Адмін групи" : m.sender_chat?.title) || [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ") || "Хтось";
  const name = who(msg);
  // Remember name → user id for real tags; the author of a replied-to message counts too. Never blocks storing.
  const seen = [msg, msg.reply_to_message].filter((m) => m?.from && !m.from.is_bot && !m.sender_chat);
  if (seen.length) await env.DB.batch(seen.map((m) => env.DB.prepare("INSERT INTO people (name, uid) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET uid = excluded.uid").bind(who(m), m.from.id)))
    .catch((e) => console.log("people:", e.message));
  // Called by her @handle → she answers. A reply to her only adds her words as context. After the webhook response (waitUntil):
  // a slow model reply must not make Telegram redeliver the update and get a second answer.
  const r0 = msg.reply_to_message;
  const toBot = r0?.from?.username === "babtsya_z_altanky_bot";
  if (update.message && !msg.forward_origin && addressesBot(raw)) {
    ctx.waitUntil(answer(env, msg, name, raw, toBot ? r0.text || r0.caption || "" : ""));
  }
  let text = messageText(msg);
  if (!text) return;
  // With several people talking the model needs to know who answers whom; forum topics make every message a "reply" to the topic.
  const r = msg.reply_to_message;
  // A forward is someone else's text, so whom it "answers" only misleads the model.
  if (r && !r.forum_topic_created && !msg.forward_origin) text = `(відповідь ${who(r)}) ${text}`;
  // Edits replace the text but keep the original time.
  await env.DB.prepare(
    "INSERT INTO messages (message_id, ts, name, tag, text) VALUES (?, ?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET text = excluded.text, name = excluded.name, tag = excluded.tag",
  ).bind(msg.message_id, msg.date, name, msg.sender_tag || null, text).run();
}

async function digest(env, day, kind, keep = false) {
  const runStart = Math.floor(Date.now() / 1000);
  const { results: rows } = await env.DB.prepare("SELECT ts, name, tag, text FROM messages WHERE ts < ? ORDER BY ts, message_id").bind(runStart).all();
  if (!rows.length) return `${kind}: нема повідомлень`;

  // ponytail: one offset for the whole run — messages across a DST switch night show ±1h.
  const offset = kyivOffsetSec(new Date());
  const lines = rows.map((r) => `[${new Date((r.ts + offset) * 1000).toISOString().slice(11, 16)}] ${r.name}: ${r.text}`);
  const tags = new Map(rows.filter((r) => r.tag).map((r) => [r.name, r.tag]));
  const header = genderLine(rows.map((r) => r.name), femaleSet(env.FEMALE_NAMES)) +
    (tags.size ? `ПІДПИСИ УЧАСНИКІВ\n${[...tags].map(([n, t]) => `${n} «${t}»`).join("\n")}\n\n` : "");
  const protectedTerms = [...new Set(rows.map((r) => r.name)), ...tags.values(), BOT_NAME];
  const prev = await env.DB.prepare("SELECT plan FROM digests WHERE plan IS NOT NULL ORDER BY created DESC LIMIT 1").first("plan");

  const play = await buildPlay(env, lines, header, prev ? prevContext(prev) : "", protectedTerms, tags);
  const prefix = env.TEST_MODE === "1" ? `[ТЕСТ · ${kind} · ${rows.length} повідомлень]\n\n` : "";

  if (!play.text) {
    // Messages stay in the base and roll into the next digest.
    await telegram(env, "sendMessage", { chat_id: target(env), text: prefix + STUB });
    await env.DB.prepare("INSERT OR REPLACE INTO digests (day, kind, plan, created) VALUES (?, ?, NULL, ?)").bind(day, kind, runStart).run();
    return `${kind}: заглушка (${play.error})`;
  }
  await telegram(env, "sendMessage", { chat_id: target(env), text: prefix + play.text });
  if (keep) return `${kind}: ${rows.length} повідомлень → ${play.text.length} символів (попередній перегляд, база не чіпалась)`;
  // Only messages that went into this digest are deleted; ones that arrived meanwhile wait for the next.
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO digests (day, kind, plan, created) VALUES (?, ?, ?, ?)").bind(day, kind, play.plan, runStart),
    env.DB.prepare("DELETE FROM messages WHERE ts < ?").bind(runStart),
  ]);
  return `${kind}: ${rows.length} повідомлень → ${play.text.length} символів`;
}

async function grumble(env, now, forced, toGroup = false) {
  const minute = slotMinute(now);
  const since = Math.floor(now / 1000) - 90 * 60;
  const lastDigest = await env.DB.prepare("SELECT MAX(created) AS t FROM digests").first("t");
  const recent = lastDigest > since ? null : await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE ts >= ?").bind(since).first("n");
  const section = GRUMBLES[forced] ? forced : grumbleSection(minute, recent);
  const list = GRUMBLES[section];
  const fallback = list[Math.floor(Math.random() * list.length)];
  // The file's phrases are the style guide; the model writes a new one each time so they don't repeat.
  // The greeting stays word for word, and a failed model call falls back to a phrase from the file.
  const phrase = section === "привітання" ? fallback : (await newGrumble(env, section, list)) || fallback;
  await telegram(env, "sendMessage", { chat_id: target(env, toGroup), text: phrase });
  return `grumble ${section} (${recent ?? "після вижимки"} за 90 хв)${phrase === fallback ? " [з файлу]" : ""}: ${phrase}`;
}

const REPLY_TEMP = 1.2; // chosen 24.09.2026 from /run?kind=sample at 0.6–1.2: funniest, still coherent

// One reply, not sent: used by the live answer and by /run?kind=sample for comparing temperatures.
async function compose(env, name, raw, botText, temperature = REPLY_TEMP) {
  const fixed = fixedReply(raw); // "@бабця + surname": the user's own answer, no model
  if (fixed) return { tone: "фраза", text: fixed };
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const image = pick(IMAGES);
  const tone = Math.random() < RUDE_SHARE ? "rude" : "wise";
  const topic = topicFor(raw, kyiv(new Date()).hour); // "@бабця + word": a matching topic replaces the random move
  const who = isFemale(name, femaleSet(env.FEMALE_NAMES)) ? "Автор — жінка: жіночий рід, «доню»." : "Автор — чоловік: чоловічий рід, «синку».";
  const said = await ai(env, replyPrompt, `${name} пише: «${raw.slice(0, 500) || "(без тексту — гіфка, стікер чи фото)"}»${botText ? `\n(це відповідь на твоє: «${botText.slice(0, 300)}»)` : ""}\n\n(Підказка лише для тебе, у відповідь її не переписуй: ${who} ${REPLY_TONES[tone]} ${topic ? topic.hint : pick(REPLY_MOVES[tone])} Порівняння бери з теми «${image}».)`, temperature, 200);
  if (!said) return { tone: topic?.key || tone, text: "" };
  let text = tidy(warFallback(stripHints(said.trim(), image).replace(/^[«"]+|[»"]+$/g, ""), raw));
  // Same corrector as the plays: replies went straight out and "той розписка" got caught by the group (24.09.2026).
  text = applyFixes(text, dedupLoop(await ai(env, polishPrompt, text, 0.2, 300)), { protectedTerms: [name, BOT_NAME] }).text;
  return { tone: topic?.key || tone, text: dropName(text, name).slice(0, 500) };
}

async function answer(env, msg, name, raw, botText) {
  const { tone, text } = await compose(env, name, raw, botText);
  if (!text) return console.log(`Відповідь ${name}: порожньо (модель нічого не дала)`);
  await telegram(env, "sendMessage", { chat_id: msg.chat.id, text, reply_parameters: { message_id: msg.message_id } })
    .then(() => console.log(`Відповідь ${name} (${tone}): ${text}`), (e) => console.log("Відповідь:", e.message));
}

// ponytail: send only — polls aren't stored, closed or tallied yet; a weekly verdict needs their message ids in D1.
async function poll(env, toGroup = false) {
  await telegram(env, "sendPoll", { chat_id: target(env, toGroup), question: QUESTION, options: OPTIONS.map((text) => ({ text })),
    // Anonymous, one answer, final vote: the weekly tally counts exactly two fixed options. Bots can't let
    // members add options (sendPoll has no such parameter), so the option list stays as sent.
    is_anonymous: true, allows_multiple_answers: false, allows_revoting: false });
  return `poll: ${QUESTION}`;
}

async function newGrumble(env, section, list) {
  const examples = [...list].sort(() => Math.random() - 0.5).slice(0, 6).join("\n");
  const said = await ai(env, grumblePrompt, `Тема: ${section}\nПриклади:\n${examples}`, 1.0, 120);
  if (!said) return "";
  let text = tidy(warFallback(stripHints(said.trim().split("\n")[0], "").replace(/^[«"]+|[»"]+$/g, ""), ""));
  text = applyFixes(text, dedupLoop(await ai(env, polishPrompt, text, 0.2, 200)), { protectedTerms: [BOT_NAME] }).text.trim();
  // A copy of an example isn't new: better the file's phrase than a disguised repeat.
  return text.length >= 15 && !list.includes(text) ? text.slice(0, 300) : "";
}

async function buildPlay(env, lines, header, context, protectedTerms, tags = new Map()) {
  const intro = "Повідомлення групи «Альтанка біля АТБ»:\n\n";
  const parts = splitChunks(lines);
  const plans = [];
  for (const [k, part] of parts.entries()) {
    let text = await ai(env, analyzePrompt, context + header + intro + part.join("\n"), 0.2);
    if (!text) return { error: "план" };
    if (parts.length > 1) text = `ЧАСТИНА ${k + 1} з ${parts.length} (${part[0].slice(1, 6)}–${part.at(-1).slice(1, 6)}):\n${text}`;
    plans.push(text);
  }
  const plan = plans.join("\n\n");

  const writerLines = withoutReposts(lines);
  const writerChat = writerLines.join("\n");
  const [lo, hi] = lengthTarget(writerLines.length);
  // Past BIG_DAY the raw chat drowns the writer: it transcribes instead of writing.
  const chatPart = writerLines.length <= BIG_DAY ? header + writerChat : "не надано — день великий, пиши лише за планом; найкращі фрази в плані дослівні";
  let play = await ai(env, writePrompt, `ОБРАЗ ДНЯ: ${IMAGES[Math.floor(Math.random() * IMAGES.length)]}\nОБСЯГ: ${writerLines.length} повідомлень — пиши ${lo}–${hi} символів, не більше ${hi}.\n\nПЛАН ДНЯ:\n${plan}\n\nЧАТ:\n${chatPart}`, WRITER_TEMP);
  if (!play) return { error: "п'єса" };

  if (play.length > HARD_LIMIT) {
    const short = await ai(env, `Скороти п'єсу до ${hi} символів: прибери найслабші ремарки й повтори. Головну розв'язку, фінальну репліку, мораль, стиль і лайку не чіпай. Поверни лише текст п'єси.`, play, 0.3);
    if (short.length > 500 && short.length < play.length) play = short;
  }
  const polished = applyFixes(play, dedupLoop(await ai(env, polishPrompt, play, 0.2, 900)), { protectedTerms });
  console.log(`Коректор: застосовано ${polished.applied.length}, відхилено ${polished.rejected.length}`, polished.rejected);
  play = polished.text;

  const war = warWords(play, writerChat);
  if (war.length) {
    const fix = await ai(env, `У тексті нижче є заборонені воєнні слова: ${war.join(", ")}. Для КОЖНОГО вживання виведи рядок «точний фрагмент з тексту => заміна без воєнної лексики», зберігаючи граматичну форму й стиль. Нічого, крім списку пар «було => стало», не пиши.`, play, 0.3, 500);
    const fixed = applyFixes(play, dedupLoop(fix), { maxOld: 200, maxNew: 220, protectedTerms });
    play = warFallback(fixed.text, writerChat);
    console.log(`Війна: ${war.join(", ")}; застосовано ${fixed.applied.length}, відхилено ${fixed.rejected.length}; лишилось: ${warWords(play, writerChat).join(", ") || "—"}`, fix.slice(0, 500));
  }
  const senders = protectedTerms.filter((t) => t !== BOT_NAME && lines.some((l) => l.includes(`] ${t}: `)));
  return { text: finalize(rollCall(castClean(castFix(play, senders), tags, senders), senders)), plan };
}

// One retry on an empty answer or an error (rate limit, "finish_reason: length"), per requirements.
async function ai(env, system, user, temperature, max_tokens = 6000) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await env.AI.run(MODEL, {
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        max_tokens, temperature,
        chat_template_kwargs: { enable_thinking: false }, // without it Gemma spends the budget thinking and returns nothing
      });
      const text = r?.response || r?.choices?.[0]?.message?.content || "";
      if (text) return text;
    } catch (e) {
      console.log("AI:", e.message);
      await new Promise((ok) => setTimeout(ok, 20000));
    }
  }
  return "";
}

// TEST_MODE sends everything to the private chat; toGroup overrides it for a one-off post.
const target = (env, toGroup = false) => (env.TEST_MODE === "1" && !toGroup ? env.TEST_CHAT_ID : env.GROUP_CHAT_ID);

async function telegram(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const json = await res.json();
  // A basic group turned into a supergroup gets a new id; Telegram names it, so the log says what to put in GROUP_CHAT_ID.
  const moved = json.parameters?.migrate_to_chat_id ? ` → новий id групи ${json.parameters.migrate_to_chat_id}, впиши його в GROUP_CHAT_ID` : "";
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}${moved}`); // never log the URL: it holds the token
  return json.result;
}

function kyiv(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), p };
}

// Kyiv minute of the day, rounded to the :00/:30 cron tick.
function slotMinute(date) {
  const { hour, p } = kyiv(date);
  return hour * 60 + Math.round(Number(p.minute) / 30) * 30;
}

// Kyiv is a whole number of hours ahead of UTC.
function kyivOffsetSec(date) {
  const { p } = kyiv(date);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - date) / 3600000) * 3600;
}
