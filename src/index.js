// Бабця з альтанки — Cloudflare Worker: Telegram webhook in, hourly digest out.
import analyzePrompt from "../prompts/analyze.txt";
import writePrompt from "../prompts/write.txt";
import polishPrompt from "../prompts/polish.txt";
import grumblesText from "../prompts/grumbles.txt";
import replyPrompt from "../prompts/reply.txt";
import grumblePrompt from "../prompts/grumble.txt";
import {
  BIG_DAY, BOT_NAME, HARD_LIMIT, applyFixes, castFix, castClean, castShuffle, rollCall, beforeMoral, copiedLines, recentMemory, fixedIsBare, fixedFor, parseVote, playTitle, committeeScore, fixNames, pointsAtOther, parseAliases, nightLine, displayName, stageHead, dedupLoop, finalize, lengthTarget, messageText,
  GRUMBLE_SLOTS, MIDDAY_QUIET, grumbleSection, parseGrumbles, addressesBot, dropName, tidy, mentionPrefix, REPLY_MOVES, REPLY_TONES, RUDE_SHARE, IMAGES, stripHints, femaleSet, isFemale, genderLine, topicFor, prevContext, teaseMinute, neighbourMinute, splitChunks, warFallback, warWords, withoutReposts,
} from "./pipeline.js";
import { OPTIONS, QUESTION, pollRemark } from "../poll.js";

const MODEL = "@cf/google/gemma-4-26b-a4b-it";
const WRITER_TEMP = 1.15; // chosen 23.09.2026 after A/B on the test stand
const MIDDAY_MIN = 50; // midday runs only at 13:00 Kyiv (24.09.2026: a 15:30 surprise play starved the evening one)
const MIDDAY_MINUTE = 13 * 60; // ponytail: one shot, no retry — if it fails, the day rolls into the evening digest
const EVENING_MIN = 50; // below it the evening is skipped and messages roll into the next digest
const GRUMBLES = parseGrumbles(grumblesText);
const POLL_MINUTE = 21 * 60; // «зрада чи перемога» at 21:00 Kyiv
const COPY_MAX = 2; // more copied replicas than this → one rewrite call (25.09.2026)
// Second corrector pass on plays only: the first one kept missing agreement and the vocative (25.09.2026).
const AGREE_PASS = "\n\nЦе другий прохід: перший коректор уже працював. Шукай ЛИШЕ порушення узгодження роду, числа й відмінка та звертання не в кличному відмінку. Решту не чіпай; якщо таких помилок нема — НЕМАЄ.";
// A tag reply (25.09.2026, "more neurons for funnier, on-topic answers"): a brief of the conversation → 3 drafts →
// a judge scores them → a weak best (< REPLY_GOOD) gets one more round with the judge's pick as the bar → corrector.
const REPLY_DRAFTS = 3;
// Neuron budget (free tier ~10k/day): a full reply is ~170 neurons. After this many replies in a Kyiv day she answers
// with one draft, no judge, no second round (~45), so a busy chat can't starve the 22:00 play into the stub.
const REPLY_FULL_MAX = 40; // 25 → 40 (user, 25.09.2026): 40 × ~170 + plays, posters, grumbles ≈ 8.5k of 10k
const REPLY_GOOD = 7; // judge score 1–10
// waitUntil lives ~30 s after the webhook answer (25.09.2026: two tags got no reply, the chain runs 10–20 s):
// a second round only if the first took < 10 s, the corrector only if < 22 s have passed, model retries after 2 s.
const REPLY_BUDGET_MS = 10000;
const REPLY_DEADLINE_MS = 22000;
const REPLY_PAUSE_MS = 2000;
const BRIEF = "Ти — уважна сусідка, що стежить за чатом. Тобі дають розмову в сусідському чаті й повідомлення до бабці. Напиши для бабці розбір — короткі рядки, сухо, без жартів:\n1. Про що зараз розмова.\n2. ПИТАННЯ: що саме автор питає, просить чи стверджує — одним реченням з усіма деталями («чи виграє збірна України», а не просто «таро»); про кого йдеться — один чоловік, одна жінка чи кілька людей; прізвиська розшифруй. Якщо автор поправляє бабцю чи пояснює слово («сємки — це насіння») — ця поправка головна.\n3. СУТЬ ВІДПОВІДІ: сам зміст відповіді — конкретно: цифра, так чи ні, назва, порада, думка («8 гривень», «так, виграє 2:1», «кіт розумніший»), одним-двома реченнями, сухо — це сировина, бабця сама переплавить її в стиль. Не переказуй питання («відповідь на питання про…» — так не можна). Не знаєш точно — все одно назви конкретну найімовірнішу відповідь (цифру, так чи ні, назву) і лише поруч познач «бабця не певна»; «невідомо», «ніхто не знає», «важко сказати» писати не можна. На питання — прямо (так чи ні, скільки, як, що порадити), хай про що воно; на твердження чи підколку — з чим бабця згодна чи ні й чому. Навіть дурне питання чи жарт отримує пряму відповідь.\n4. Конкретний смішний кут: деталь, протиріччя чи абсурд у самому предметі — людині, події, речі, про які питають (не про форму питання: «коротке», «без дієслова», «як звіт» — так не можна). Він є завжди — знайди його; «відсутній» писати не можна.\n5. ПАМ'ЯТЬ: якщо в ХРОНІЦІ ДВОРУ чи в тому, ЩО БУЛО В ДВОРІ, є історія, мем чи прізвисько, що пасує саме до цього питання, — одним рядком яке; не пасує нічого — «—». Минуле не тягни, де воно не до речі.\n6. Адресат. Якщо повідомлення автора — відповідь іншій людині і автор просить бабцю щось сказати, дати чи зробити саме їй («видай Олі пігулок», «скажи їй»), напиши «Адресат: ІНШИЙ». Інакше — «Адресат: АВТОР».\nНічого не вигадуй — лише те, що є в розмові.";
const JUDGE = "Ти — редактор гумору. Тобі дають розмову в сусідському чаті, повідомлення до бабці й кілька варіантів її відповіді. Оціни кожен від 1 до 10. 1) Чи відповідає варіант на те, що спитали чи сказали (ПИТАННЯ з розбору), конкретно — цифрою, так чи ні, назвою, порадою: ні, або «ніхто не знає» — щонайбільше 3 бали, хай який смішний. 2) Стиль Подерв'янського (пафос, гротеск, суржик, соковитий мат, абсурдне «а отже»): прісна «нормальна» відповідь — щонайбільше 5; сухий факт-довідка на початку — мінус два. 3) Смішно, несподівано й у тему розмови. Мінус бали: не той рід чи граматика, вигадані факти про реальних людей, повтори слів, пояснення жарту, шаблонний фінал «…, блядь, суцільний …» — мінус два; заїжджений образ (банки, огірки, соління, голуби, ЖЕК, «Електрон»), якого нема в розмові, — мінус три. Відповідай одним рядком: номер найкращого варіанта й його оцінка, наприклад «2 8». Нічого більше.";
// Pictures (25.09.2026): a poster before the evening play, a meat photo with the Lida tease. FLUX.1 schnell on
// Workers AI, ~60 neurons a picture by Cloudflare's price list. No text in the picture (the model garbles letters),
// no real people — the caption carries the words.
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
// The poster gets the scene headings, not just the title: from a title alone it drew a sack of vegetables for
// "від гепатиту до шлункової диверсії" (25.09.2026). One concrete moment of the day's main story.
const POSTER = "Ти пишеш опис картинки-афіші до п'єси сусідського чату для генератора зображень. Тобі дають назву й заголовки сцен. Обери ОДИН конкретний смішний момент із головної історії дня (що саме роблять люди, який предмет у центрі) і опиши його АНГЛІЙСЬКОЮ одним-двома реченнями: двір панельного будинку, альтанка біля супермаркету, лавка, бурчлива бабця-оповідачка, сусіди — без конкретних облич. Без реальних людей і імен, без тексту й літер на картинці, без війни й зброї. Весело й яскраво, без похмурих чи загрозливих фігур. Лише опис англійською, нічого більше.";
// Style goes first: FLUX weighs the start of the prompt most, and a trailing "gouache poster" came out as a dark photo (25.09.2026).
const POSTER_STYLE = "Bright naive folk-art illustration, flat vivid colors, thick outlines, humorous cartoon, cheerful warm light. ";
const POSTER_END = " No text, no letters, no signs.";
const MEATS = ["juicy shashlik on metal skewers over glowing coals", "a huge smoked pork knuckle", "sizzling sausages on a grill",
  "a thick ribeye steak on a wooden board", "a plate of homemade cutlets with fried onions", "Ukrainian salo — thick slices of white cured pork fat with a thin meat layer, garlic and rye bread"];
const oneOf = (list) => list[Math.floor(Math.random() * list.length)];
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
          out.push(`t=${t} (${r.tone}, оцінка ${r.score ?? "—"}): ${r.text || "—"}${r.brief ? `\n   розбір: ${r.brief.replace(/\n+/g, " | ")}` : ""}`);
        }
        return new Response(out.join("\n"));
      }
      // ?kind=poll[&to=group] — one poll now, same as the 21:00 one.
      if (kind === "poll") return new Response(await poll(env, toGroup));
      // ?kind=chronicle — rebuild the yard's chronicle now and see it here (no chat).
      if (kind === "chronicle") return new Response(await chronicle(env).catch((e) => `chronicle: помилка — ${e.message}`));
      // ?kind=stock — one more scored meat picture into the stock (D1 only, no chat).
      if (kind === "stock") return new Response(await stockMeat(env));
      // ?kind=poster[&title=«…»][&to=me] and ?kind=tease[&to=me] — one picture now; to=me goes to your private chat.
      if (kind === "poster" || kind === "tease") {
        const chat = url.searchParams.get("to") === "me" ? env.TEST_CHAT_ID : target(env, toGroup);
        return new Response(kind === "tease" ? await tease(env, chat)
          : await poster(env, chat, url.searchParams.get("title") || "«Бляха-муха, монстр у системі та холодильники з благословенням»"));
      }
      const { day } = kyiv(new Date());
      // &keep=1 — a preview: messages stay in the base and the digest isn't recorded, so the real one still covers the day.
      // Only an explicit manual digest reaches the group: an unknown kind (kind=judgepic before its deploy) once fell
      // through here, posted a play into the group and ate 101 messages of the evening one (25.09.2026).
      if (kind !== "manual") return new Response(`невідомий kind=${kind} — нічого не зроблено`, { status: 400 });
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
    if (hour >= 22) await closePoll(env, day).catch((e) => console.log("poll close:", e.message));
    if (hour >= 22 && !(await done("evening")) && (await pending()) >= EVENING_MIN) {
      console.log(await digest(env, day, "evening"));
      posted = true;
    }
    // A grumble right under a fresh digest would bury it.
    const m = slotMinute(now);
    const afterMidday = m >= MIDDAY_QUIET[0] && m < MIDDAY_QUIET[1] && (await done("midday"));
    if (!posted && !afterMidday && GRUMBLE_SLOTS.includes(m)) console.log(await grumble(env, now));
    if (slotMinute(now) === neighbourMinute(day)) console.log(await grumble(env, now, "сусід"));
    if (env.TEASE && slotMinute(now) === teaseMinute(day)) console.log(await tease(env, target(env)).catch((e) => `tease: ${e.message}`));
    // Night refill after the 03:00 neuron reset: one picture per tick 04:00–05:30 while the stock is short.
    if (env.TEASE && m >= 240 && m <= 330) {
      const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM pics WHERE kind = 'meat' AND used IS NULL").first("n").catch(() => STOCK_MIN);
      if (left < STOCK_MIN) console.log(await stockMeat(env).catch((e) => `stock: ${e.message}`));
    }
    if (m === 210 && new Date(`${day}T12:00:00Z`).getUTCDay() === 1) console.log(await chronicle(env).catch((e) => `chronicle: ${e.message}`));
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
  const who = (m) => displayName((m.sender_chat?.id === m.chat?.id ? "Адмін групи" : m.sender_chat?.title) || [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ") || "Хтось");
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
    const other = r0 && !toBot && r0.from && !r0.from.is_bot && !r0.forum_topic_created
      ? { name: who(r0), text: r0.text || r0.caption || "", id: r0.message_id, username: r0.from.username, uid: r0.from.id } : null;
    // Whom the message tags: @username or a name tag (text_mention) — the surest sign it's meant for them.
    const mentions = (msg.entities || msg.caption_entities || []).map((e) =>
      e.type === "text_mention" ? { id: e.user?.id } : e.type === "mention" ? { username: raw.slice(e.offset + 1, e.offset + e.length) } : null).filter(Boolean);
    if (other) other.forced = pointsAtOther(raw, mentions, other, parseAliases(env.ALIASES).get(other.name));
    ctx.waitUntil(answer(env, msg, name, raw, toBot ? r0.text || r0.caption || "" : "", other));
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

  const play = await buildPlay(env, lines, header, prev ? prevContext(prev) : "", protectedTerms, tags, kind === "evening" ? await pollText(env, day).catch((e) => (console.log("poll text:", e.message), "")) : "");
  const prefix = env.TEST_MODE === "1" ? `[ТЕСТ · ${kind} · ${rows.length} повідомлень]\n\n` : "";

  if (!play.text) {
    // Messages stay in the base and roll into the next digest.
    await telegram(env, "sendMessage", { chat_id: target(env), text: prefix + STUB });
    await env.DB.prepare("INSERT OR REPLACE INTO digests (day, kind, plan, created) VALUES (?, ?, NULL, ?)").bind(day, kind, runStart).run();
    return `${kind}: заглушка (${play.error})`;
  }
  const title = playTitle(play.text);
  // A poster before both scheduled plays (user, 25.09.2026); a manual preview stays text only.
  if ((kind === "evening" || kind === "midday") && title) console.log(await poster(env, target(env), title, kind, (play.text.match(/^\(Сцена [^\n]*$/gm) ?? []).slice(0, 4).join("\n")).catch((e) => `poster: ${e.message}`));
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
// other = the member the tagged message replies to ({ name, text, id }): "@бабця видай Олі пігулок" as a reply to
// Nina is meant for Nina (25.09.2026) — the brief decides whom she answers.
async function compose(env, name, raw, botText, temperature = REPLY_TEMP, context = "", other = null, draftsN = REPLY_DRAFTS) {
  const rule = fixedFor(raw), fixed = rule?.text; // "@бабця + surname": the user's own answer
  if (fixed && (rule.always || fixedIsBare(raw))) return { tone: "фраза", text: fixed }; // just the name (or Порошенко) — word for word
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  // With more than the name the fixed phrase leads and the model carries on: "шизік, знов дуріє…" (26.09.2026).
  const topic = fixed ? { key: "фраза+", hint: `Про цю людину в бабці одна думка — «${fixed}». Почни відповідь дослівно з «${fixed}» і розвинь далі по суті того, що спитали, українською, у стилі Подерв'янського.${rule.angles ? " Розвивай за напрямком із розбору (ПАМ'ЯТЬ і СУТЬ), своїми словами, не дослівно." : ""}` }
    : topicFor(raw, kyiv(new Date()).hour); // "@бабця + word": a matching topic replaces the random move
  const tone = !["хороше", "рецепт", "вірш"].includes(topic?.key) && Math.random() < RUDE_SHARE ? "rude" : "wise"; // never rude for "good" or a recipe
  // Who in the conversation is a woman, so a mentioned member gets the right gender and case (25.09.2026).
  const gender = genderLine([name, other?.name, ...context.split("\n").map((l) => l.split(": ")[0])].filter(Boolean), femaleSet(env.FEMALE_NAMES));
  const present = new Set([name, other?.name, ...context.split("\n").map((l) => l.split(": ")[0])]);
  const aka = [...parseAliases(env.ALIASES)].filter(([n]) => present.has(n)).map(([n, f]) => `${n} — ${f.join(", ")}`).join("; ");
  const talk = `${gender}${aka ? `ХТО Є ХТО (імена в житті): ${aka}.\n\n` : ""}${context ? `РОЗМОВА ПЕРЕД ЦИМ (лише щоб зрозуміти, про що мова):\n${context}\n\n` : ""}`;
  const asked = `${name} пише: «${raw.slice(0, 500) || "(без тексту — гіфка, стікер чи фото)"}»${botText ? `\n(це відповідь на твоє: «${botText.slice(0, 300)}»)` : ""}${other ? `\n(це відповідь на повідомлення ${other.name}: «${other.text.slice(0, 300)}»)` : ""}`;
  const start = Date.now();
  // 1. What's going on, what's asked, who's who ("тарас" is one man) — the drafts answer the brief, not raw lines.
  const local = replyPrompt.match(/^Місцеві слова:.*$/m)?.[0] ?? "";
  // Always, not only with chat context: a bare "чи женимо тарас?" got a generic threat instead of an answer (25.09.2026).
  // One direction per reply, picked by code: with the whole list the brief copied all of it and every answer about
  // Зеленський was the tennis with Єрмак (26.09.2026).
  const angle = rule?.angles ? pick(rule.angles.split(";").map((a) => a.trim())) : "";
  const opinion = fixed ? `\n(бабцина думка про цю людину: «${fixed}»${angle ? `; цього разу зачепися за: ${angle} — або придумай свій кут у цьому дусі` : ""})` : "";
  const brief = (await ai(env, `${BRIEF}\n${local}`, `${await memory(env)}${talk}${asked}${opinion}`, 0.2, 400, REPLY_PAUSE_MS)).trim();
  const ctx = `${talk}${brief ? `РОЗБІР (для тебе, у відповідь не переписуй):\n${brief}\n\n` : ""}`;
  const to = other && (other.forced || /Адресат:\s*ІНШ/i.test(brief)) ? other.name : name;
  const woman = isFemale(to, femaleSet(env.FEMALE_NAMES));
  const who = `${to === name ? "Автор" : `Відповідай не автору, а ${to} — звертайся до ${woman ? "неї" : "нього"}. Адресат`} — ${woman ? "жінка: жіночий рід, «доню»" : "чоловік: чоловічий рід, «синку»"}.`;
  const long = topic?.long; // a recipe needs room
  // 2. Same tone for all drafts (the rude/wise ratio holds), a different move and image each — that's the variety.
  const draft = async (bar = "") => {
    const image = pick(IMAGES);
    const said = await ai(env, replyPrompt, `${ctx}${asked}\n\n(Підказка лише для тебе, у відповідь її не переписуй: ${who} ${REPLY_TONES[tone]} ${topic ? pick([].concat(topic.hint)) : pick(REPLY_MOVES[tone])} Порівняння бери з теми «${image}».${long ? " Тут можна довше — до 12 рядків." : ""}${bar})`, temperature, long ? 500 : 200, REPLY_PAUSE_MS);
    return said ? tidy(warFallback(stripHints(said.trim(), image).replace(/^[«"]+|[»"]+$/g, ""), raw)) : "";
  };
  const drafts = async (bar) => (await Promise.all(Array.from({ length: draftsN }, () => draft(bar)))).filter(Boolean);
  // 3. The judge scores; a single draft is taken as is.
  const judge = async (list) => list.length < 2 ? { best: 0, score: 10 }
    : parseVote(await ai(env, JUDGE, `${ctx}${asked}\n\nВаріанти:\n${list.map((d, i) => `${i + 1}. ${d}`).join("\n")}`, 0.2, 8, REPLY_PAUSE_MS), list.length);
  let pool = await drafts();
  if (!pool.length) return { tone: topic?.key || tone, text: "" };
  let { best, score } = await judge(pool);
  const first = score;
  if (draftsN > 1 && score < REPLY_GOOD && Date.now() - start < REPLY_BUDGET_MS) {
    const more = await drafts(` Попередній найкращий варіант слабкий: «${pool[best]}». Зроби смішніше, точніше по суті й коротше, іншим ходом.`);
    pool = [pool[best], ...more];
    ({ best, score } = await judge(pool));
  }
  console.log(`Відповідь ${name}: розбір ${brief ? "є" : "—"}, оцінка ${first}${pool.length > REPLY_DRAFTS ? ` → другий раунд ${score}` : ""}, ${Date.now() - start} мс`);
  let text = pool[best];
  // Same corrector as the plays: replies went straight out and "той розписка" got caught by the group (24.09.2026).
  if (Date.now() - start < REPLY_DEADLINE_MS)
    text = applyFixes(text, dedupLoop(await ai(env, polishPrompt, gender + text, 0.2, 300, REPLY_PAUSE_MS)), { protectedTerms: [name, BOT_NAME] }).text;
  if (fixed && !text.toLowerCase().startsWith(fixed.toLowerCase())) text = `${fixed[0].toUpperCase()}${fixed.slice(1)}. ${text}`; // the phrase always leads
  text = fixNames(text, [name, other?.name, ...context.split("\n").map((l) => l.split(": ")[0])].filter(Boolean));
  return { tone: topic?.key || tone, text: dropName(text, to).slice(0, long ? 1500 : 500), brief, score, to };
}

async function answer(env, msg, name, raw, botText, other = null) {
  // The last 20 messages, so she answers the conversation and not just the one line (25.09.2026).
  // ponytail: right after a play the table is emptied and there's little context until people write again.
  const { results } = await env.DB.prepare("SELECT name, text FROM messages WHERE message_id != ? ORDER BY ts DESC LIMIT 20").bind(msg.message_id).all();
  const context = results.reverse().map((r) => `${r.name}: ${r.text}`).join("\n");
  // "Бабця з альтанки друкує…" while the chain runs; Telegram shows it for ~5 s, so it's renewed.
  const typing = () => telegram(env, "sendChatAction", { chat_id: msg.chat.id, action: "typing" }).catch(() => {});
  typing();
  const tick = setInterval(typing, 4500);
  const n = await env.DB.prepare("INSERT INTO usage (day, replies) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET replies = replies + 1 RETURNING replies")
    .bind(kyiv(new Date()).day).first("replies").catch(() => 0); // no table yet → full replies, as before
  const lean = n > REPLY_FULL_MAX;
  const { tone, text, to } = await compose(env, name, raw, botText, REPLY_TEMP, context, other, lean ? 1 : REPLY_DRAFTS).finally(() => clearInterval(tick));
  if (!text) return console.log(`Відповідь ${name}: порожньо (модель нічого не дала)`);
  const replyTo = to && to !== name && other ? other.id : msg.message_id; // reply to the member she answers
  await telegram(env, "sendMessage", { chat_id: msg.chat.id, text, reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } })
    .then(() => console.log(`Відповідь ${to || name} (${tone}${lean ? `, економ №${n}` : ""}): ${text}`), (e) => console.log("Відповідь:", e.message));
}

async function poll(env, toGroup = false) {
  const sent = await telegram(env, "sendPoll", { chat_id: target(env, toGroup), question: QUESTION, options: OPTIONS.map((text) => ({ text })),
    // Anonymous, one answer, final vote: the weekly tally counts exactly two fixed options. Bots can't let
    // members add options (sendPoll has no such parameter), so the option list stays as sent.
    is_anonymous: true, allows_multiple_answers: false, allows_revoting: false });
  await env.DB.prepare("INSERT OR REPLACE INTO polls (day, chat_id, message_id) VALUES (?, ?, ?)").bind(kyiv(new Date()).day, String(sent.chat.id), sent.message_id).run();
  return `poll: ${QUESTION}`;
}

// 22:00: today's poll is closed and counted before the evening play reads it.
async function closePoll(env, day) {
  const row = await env.DB.prepare("SELECT chat_id, message_id FROM polls WHERE day = ? AND zrada IS NULL").bind(day).first();
  if (!row) return;
  const p = await telegram(env, "stopPoll", { chat_id: row.chat_id, message_id: row.message_id });
  const [zrada, peremoga] = OPTIONS.map((o) => p.options.find((x) => x.text === o)?.voter_count ?? 0);
  await env.DB.prepare("UPDATE polls SET zrada = ?, peremoga = ? WHERE day = ?").bind(zrada, peremoga, day).run();
  console.log(`poll closed: зрада ${zrada} — перемога ${peremoga}`);
}

// The day's verdict for the evening play; on Sunday the Monday–Sunday week follows.
// ponytail: a skipped evening play (<50 messages) skips the verdict, and on Sunday the week's too.
async function pollText(env, day) {
  const today = await env.DB.prepare("SELECT zrada, peremoga FROM polls WHERE day = ? AND zrada IS NOT NULL").bind(day).first();
  if (!today || new Date(`${day}T12:00:00Z`).getUTCDay() !== 0) return pollRemark(today);
  const monday = new Date(Date.parse(day) - 6 * 864e5).toISOString().slice(0, 10);
  const { results: week } = await env.DB.prepare("SELECT zrada, peremoga FROM polls WHERE day >= ? AND day <= ? AND zrada IS NOT NULL").bind(monday, day).all();
  return pollRemark(today, week);
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

async function buildPlay(env, lines, header, context, protectedTerms, tags = new Map(), remark = "") {
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
  const chatPart = writerLines.length <= BIG_DAY ? header + writerChat : "не надано — день великий, пиши лише за планом; найкраща фраза кожної теми в плані дослівна";
  const image = IMAGES[Math.floor(Math.random() * IMAGES.length)], night = nightLine(writerLines);
  const chron = await env.DB.prepare("SELECT text FROM chronicle ORDER BY created DESC LIMIT 1").first("text").catch(() => null);
  let play = await ai(env, writePrompt, `${chron ? `ХРОНІКА ДВОРУ (давні історії й меми):\n${chron}\n\n` : ""}ОБРАЗ ДНЯ: ${image}\nОБСЯГ: ${writerLines.length} повідомлень — пиши ${lo}–${hi} символів, не більше ${hi}.\n${night}\n\nПЛАН ДНЯ:\n${plan}\n\nЧАТ:\n${chatPart}`, WRITER_TEMP);
  if (!play) return { error: "п'єса" };

  if (play.length > HARD_LIMIT) {
    const short = await ai(env, `Скороти п'єсу до ${hi} символів: прибери найслабші ремарки й повтори. Головну розв'язку, фінальну репліку, мораль, стиль і лайку не чіпай. Поверни лише текст п'єси.`, play, 0.3);
    if (short.length > 500 && short.length < play.length) play = short;
  }
  const copied = copiedLines(play, writerLines);
  if (copied.length > COPY_MAX) {
    const fix = await ai(env, "Ці репліки п'єси майже дослівно переписані з чату сусідів. Перекажи кожну своїми словами в стилі п'єси Подерв'янського: пафос на рівному місці, абсурдне порівняння з побутом, суржик і мат лишаються, зміст не змінюй, ім'я героя на початку не чіпай. Для КОЖНОЇ репліки виведи рядок «стара репліка => нова репліка». Нічого, крім цих пар, не пиши.", copied.join("\n"), 0.9, 900);
    const r = applyFixes(play, dedupLoop(fix), { maxOld: 400, maxNew: 450, protectedTerms, hedging: null });
    play = r.text;
    console.log(`Переказ: скопійовано ${copied.length}, переписано ${r.applied.length}, відхилено ${r.rejected.length}`);
  }
  for (const [pass, prompt, tokens] of [["Коректор", polishPrompt, 900], ["Узгодження", polishPrompt + AGREE_PASS, 600]]) {
    const polished = applyFixes(play, dedupLoop(await ai(env, prompt, (header.match(/^СТАТЬ:.*\n\n/)?.[0] ?? "") + play, 0.2, tokens)), { protectedTerms });
    console.log(`${pass}: застосовано ${polished.applied.length}, відхилено ${polished.rejected.length}`, polished.rejected);
    play = polished.text;
  }

  const war = warWords(play, writerChat);
  if (war.length) {
    const fix = await ai(env, `У тексті нижче є заборонені воєнні слова: ${war.join(", ")}. Для КОЖНОГО вживання виведи рядок «точний фрагмент з тексту => заміна без воєнної лексики», зберігаючи граматичну форму й стиль. Нічого, крім списку пар «було => стало», не пиши.`, play, 0.3, 500);
    const fixed = applyFixes(play, dedupLoop(fix), { maxOld: 200, maxNew: 220, protectedTerms });
    play = warFallback(fixed.text, writerChat);
    console.log(`Війна: ${war.join(", ")}; застосовано ${fixed.applied.length}, відхилено ${fixed.rejected.length}; лишилось: ${warWords(play, writerChat).join(", ") || "—"}`, fix.slice(0, 500));
  }
  const senders = protectedTerms.filter((t) => t !== BOT_NAME && lines.some((l) => l.includes(`] ${t}: `)));
  play = fixNames(play, senders);
  const staged = rollCall(castShuffle(castClean(castFix(play, senders), tags, senders)), senders);
  return { text: finalize(stageHead(remark ? beforeMoral(staged, remark) : staged, image, night.match(/«(.+)»\.$/)?.[1])), plan };
}

// One retry on an empty answer or an error (rate limit, "finish_reason: length"), per requirements.
async function ai(env, system, user, temperature, max_tokens = 6000, pause = 20000) {
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
      await new Promise((ok) => setTimeout(ok, pause));
    }
  }
  return "";
}

// Memory for a tag reply (26.09.2026): B — the yard's chronicle, A — the last six digests' topics and endings.
// Both come from plans already stored in digests; a missing table just means no memory.
async function memory(env) {
  const chron = await env.DB.prepare("SELECT text FROM chronicle ORDER BY created DESC LIMIT 1").first("text").catch(() => null);
  const { results } = await env.DB.prepare("SELECT day, kind, plan FROM digests WHERE plan IS NOT NULL ORDER BY created DESC LIMIT 6").all().catch(() => ({ results: [] }));
  const recent = recentMemory(results);
  return `${chron ? `ХРОНІКА ДВОРУ (давні історії й меми):\n${chron}\n\n` : ""}${recent ? `ЩО БУЛО В ДВОРІ ОСТАННІМИ ДНЯМИ:\n${recent}\n\n` : ""}`;
}

// B: every Monday the week's plans are folded into the previous chronicle — stories that run between days, memes,
// local words, nicknames. Cumulative, so after a month she knows the chat. No health, family or private life.
const CHRONICLE = "Ти — літописиця двору. Тобі дають попередню хроніку двору й плани випусків за тиждень. Онови хроніку: до 15 коротких пунктів, кожен рядок починається з «- ». Лише життя двору: історії, що тягнуться між днями, повторювані жарти й меми, місцеві слова й прізвиська, спільні справи сусідів. Нове додай, застаріле й разове прибери. НЕ пиши: новини, політику, війну, обстріли, зброю, фронт; адреси й телефони; оцінки людей; як влаштований сам бот чи коли він що публікує. Без заголовків, без зірочок і жирного — лише рядки «- …».";
// C (off unless PEOPLE_NOTES = "1"): what each member is known for. Stored, read nowhere yet.
const NOTES = "Тобі дають плани випусків сусідського чату за тиждень. Для кожного учасника, що там є, напиши один рядок «Ім'я: …» — чим він відомий у дворі: теми, захоплення, повторювані жарти, улюблені слівця. Без здоров'я, родини, адрес, роботи, грошей, оцінок і особистого життя. Лише рядки «Ім'я: …», нічого більше.";
async function chronicle(env) {
  const now = Math.floor(Date.now() / 1000);
  const { results } = await env.DB.prepare("SELECT day, kind, plan FROM digests WHERE plan IS NOT NULL AND created >= ? ORDER BY created").bind(now - 7 * 86400).all();
  if (!results.length) return "chronicle: нема планів за тиждень";
  const week = results.map((r) => `${r.day} ${r.kind}:\n${r.plan}`).join("\n\n").slice(0, 40000);
  const prev = await env.DB.prepare("SELECT text FROM chronicle ORDER BY created DESC LIMIT 1").first("text");
  // Only "- " lines survive: headings, a bare "—" (the empty previous chronicle echoed) and markdown stars go (26.09.2026).
  const text = tidy(await ai(env, CHRONICLE, `ПОПЕРЕДНЯ ХРОНІКА:\n${prev || "(ще нема)"}\n\nПЛАНИ ЗА ТИЖДЕНЬ:\n${week}`, 0.3, 1200))
    .split("\n").map((l) => l.replace(/[*#_]/g, "").trim()).filter((l) => /^[-•]\s*\S/.test(l)).map((l) => l.replace(/^[-•]\s*/, "- ")).join("\n").slice(0, 3000);
  if (!text) return "chronicle: модель нічого не дала";
  await env.DB.prepare("INSERT INTO chronicle (week, text, created) VALUES (?, ?, ?) ON CONFLICT(week) DO UPDATE SET text = excluded.text, created = excluded.created")
    .bind(kyiv(new Date()).day, text, now).run();
  let notes = 0;
  if (env.PEOPLE_NOTES === "1") {
    const lines = (await ai(env, NOTES, week, 0.3, 1200)).split("\n").map((l) => l.match(/^\s*(.{2,40}?):\s*(.{5,300})$/)).filter(Boolean);
    if (lines.length) await env.DB.batch(lines.map(([, name, note]) => env.DB.prepare("INSERT INTO people_notes (name, notes, updated) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET notes = excluded.notes, updated = excluded.updated").bind(name.trim(), note.trim(), now)));
    notes = lines.length;
  }
  return `chronicle: ${text.length} символів${env.PEOPLE_NOTES === "1" ? `, нотаток про людей: ${notes}` : ""}\n${text}`;
}

// A picture as base64 JPEG, or null — a failed picture never blocks the text it goes with.
async function draw64(env, prompt) {
  try {
    return (await env.AI.run(IMAGE_MODEL, { prompt, steps: 4 }))?.image || null;
  } catch (e) {
    console.log("draw:", e.message);
    return null;
  }
}
const jpegBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const draw = async (env, prompt) => {
  const b64 = await draw64(env, prompt);
  return b64 ? jpegBytes(b64) : null;
};

// The committee (25.09.2026 spike: of four vision models only our Gemma 4 could see the picture, 1.2 s, within the
// CPU limit). Three questions in parallel, each "only the number"; the stock keeps the average.
// First real batch (25.09.2026 15:45): "realistic" gave 3 to every picture (it sees they're generated) and "flaws"
// 3–4 to clean ones — constant penalties, no ranking. Only "appetizing" told pictures apart, so all three ask that.
const COMMITTEE = [
  "How appetizing does this food look? Answer with only a number from 1 to 10.",
  "Would a hungry person want to eat this right now? Answer with only a number from 1 to 10.",
  "As a picture to tease a friend who is always eating: how tasty and eye-catching is it? Answer with only a number from 1 to 10.",
];
const STOCK_MIN = 3; // fewer unused meat pictures than this → the night refill adds one per tick 04:00–05:30
async function committee(env, b64) {
  const ask = (q) => env.AI.run(MODEL, {
    messages: [{ role: "user", content: [{ type: "text", text: q }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } }] }],
    max_tokens: 10, temperature: 0.2, chat_template_kwargs: { enable_thinking: false },
  }).then((r) => r?.response || r?.choices?.[0]?.message?.content || "", () => "");
  const answers = await Promise.all(COMMITTEE.map(ask));
  return { score: committeeScore(answers), answers };
}

// One meat picture into the stock: drawn, scored, kept in D1 as base64 until the tease sends it. Nothing goes to
// any chat (25.09.2026: "мені в особисті вже нічого не має слати").
async function stockMeat(env) {
  const b64 = await draw64(env, `${oneOf(MEATS)}, appetizing close-up food photo, rustic kitchen table, warm light, no text.`);
  if (!b64) return "stock: картинка не намалювалась";
  const { score, answers } = await committee(env, b64);
  if (score == null) return `stock: комітет не відповів (${answers.join(" / ")})`;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("INSERT INTO pics (file_id, kind, score, created, data) VALUES (?, 'meat', ?, ?, ?)").bind(`pic-${Date.now()}`, score, now, b64).run();
  return `stock: ${score} (${answers.map((x) => x.trim()).join(" / ")})`;
}

async function sendPhoto(env, chat, jpeg, caption) {
  const form = new FormData();
  form.append("chat_id", String(chat));
  form.append("caption", caption.slice(0, 1024)); // Telegram's caption limit
  form.append("photo", new Blob([jpeg], { type: "image/jpeg" }), "babtsya.jpg");
  const json = await (await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: "POST", body: form })).json();
  if (!json.ok) throw new Error(`Telegram sendPhoto: ${json.description}`); // never log the URL: it holds the token
  return json.result;
}

// Evening poster: Gemma turns the title into an English scene, FLUX draws it, the title goes in the caption.
async function poster(env, chat, title, kind = "evening", scenes = "") {
  const scene = (await ai(env, POSTER, `Назва п'єси: ${title}${scenes ? `\nСцени:\n${scenes}` : ""}`, 0.9, 150)).trim();
  const jpeg = scene ? await draw(env, POSTER_STYLE + scene + POSTER_END) : null;
  if (!jpeg) return "poster: без картинки";
  // No title here: the play right below opens with it (25.09.2026, "дублювання").
  await sendPhoto(env, chat, jpeg, `Сьогодні ${kind === "midday" ? "вдень" : "ввечері"} на альтанці.`);
  return `poster: ${scene}`;
}

// The Lida tease with a meat photo; if the picture fails, the words still go.
async function tease(env, chat) {
  const best = await env.DB.prepare("SELECT file_id, score, data FROM pics WHERE kind = 'meat' AND used IS NULL ORDER BY score DESC LIMIT 1").first();
  if (best) {
    if (best.data) await sendPhoto(env, chat, jpegBytes(best.data), env.TEASE);
    // ponytail: the 4 first-day rows hold a Telegram file_id, not data; drop this branch once they're all used.
    else await telegram(env, "sendPhoto", { chat_id: chat, photo: best.file_id, caption: env.TEASE });
    // A preview in your private chat doesn't spend the stock; a sent picture's bytes are dropped.
    if (String(chat) !== String(env.TEST_CHAT_ID)) await env.DB.prepare("UPDATE pics SET used = ?, data = NULL WHERE file_id = ?").bind(Math.floor(Date.now() / 1000), best.file_id).run();
    return `tease із запасу (${best.score}): ${env.TEASE}`;
  }
  const jpeg = await draw(env, `${oneOf(MEATS)}, appetizing close-up food photo, rustic kitchen table, warm light, no text.`);
  if (jpeg) await sendPhoto(env, chat, jpeg, env.TEASE);
  else await telegram(env, "sendMessage", { chat_id: chat, text: env.TEASE });
  return `tease${jpeg ? " з картинкою" : ""}: ${env.TEASE}`;
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
