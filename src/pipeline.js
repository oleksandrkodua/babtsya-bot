// Pure text pipeline for the digest — no Cloudflare, no Telegram. `node src/pipeline.js` runs the self-check.
// Every rule here was found necessary in test runs; the self-check keeps the real cases that forced it.

export const HARD_LIMIT = 3900; // Telegram rejects messages over 4096 chars
export const BIG_DAY = 300; // past this the plan is chunked and the writer gets the plan only
const CHUNK = 250; // ponytail: one plan call lost topics at ~900 messages; 250 is a first guess
export const BOT_NAME = "Бабця з альтанки";
// "@babtsya_z_altanky_bot тупа корова" reached the model as a bare handle it didn't recognise, and the insult
// landed on another member (24.09.2026); the handle becomes the bot's name.
const BOT_HANDLE = /@babtsya_z_altanky_bot\b/gi;

// JS \b is ASCII-only, so Cyrillic word starts need a lookbehind.
const WORD_START = "(?<![\\p{L}\\p{N}_])";
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // a literal inside a RegExp
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;
// Only reposts are filtered (user's decision); the chat mixes Ukrainian and Russian.
// Monitoring channels write in jargon ("розвідрон", "КАБи", "Бандеролі", "Су-34"), so some stems match mid-word
// and short ones need a word end. What slips through is stored as a content-free stub anyway.
const WORD_END = "(?![\\p{L}])";
const WAR_REPOST = new RegExp(
  "(?:дрон|шахед|обстріл|обстрел|ракет|балісти|баллисти|бандерол|влучан|прильот|прилёт|бомб|снаряд)" +
  `|${WORD_START}(?:вибух|взрыв|загибл|погиб|поранен|ранен|окупант|оккупант|ворог|враг|атак|удар|тривог|тревог|війн|войн|перемир|іскандер|искандер|кинджал|кинжал|калібр|калибр|онікс|оникс|ядер|бпла|фпв|fpv)` +
  `|${WORD_START}(?:приліт|прилет(?:ы|ов|а|у|ом)?|кр|каб(?:и|ів|ы|ов)?|ппо|пво|су-?\\d\\d|мі-?\\d+|ми-?\\d+)${WORD_END}`,
  "iu",
);
// Output backstop: war words used as metaphors. "вибухаючи/вибухнула" (emotion) is allowed.
const WAR_WORDS = new RegExp(WORD_START + "(?:порох|вибух(?!а|н)|розстріл|фронт|окоп|терор|снаряд|бомб|війн|контрнаступ|партизан|загарбн|окупа|диверс|штурм|артилер|мародер|битв|бітв|карател)", "giu");
const REDACTIONS = [
  [/(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g, "[номер картки]"],
  [/(?<!\d)\+?38[\s-]?\(?0?[\s-]?\d{2}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?!\d)/g, "[номер телефону]"],
  [/(?<![\d+])\(?0\d{2}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?!\d)/g, "[номер телефону]"],
  [/(?:https?:\/\/|t\.me\/)\S+/gi, "[посилання]"], // invite links to private groups must not reach the model
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]"],
];
const SUSPECT_COMMENTARY = /[()]|тут |якщо |можна |або |проте |стилістично|граматично|контекстуально|помилки немає|мається на увазі|у значенні|залишаємо|краще так|варіант/i;
const STATIC_FIXES = { воїтелька: "войовниця", голубамими: "голубами", летописка: "літописиця", Сінку: "Синку", сінку: "синку", жалікими: "жалюгідними", аотже: "а отже", Аотже: "А отже", кабачке: "кабачку", "в зенит": "в зеніті", "на деле": "на ділі", затея: "затія", затею: "затію", затеї: "затії" };
// "Бабця, ти сьогодні…" — addressing her needs the vocative (25.09.2026). Only at the start of a line or a reply,
// so a remark "(Бабця, як завжди, мовчить)" keeps the nominative.
const VOCATIVE = /(^|: |— )Бабця(?=, )/gm;

const redact = (t) => REDACTIONS.reduce((s, [re, ph]) => s.replace(re, ph), t);
// "@nick" in the digest would ping that person; the bare nick keeps the meaning without a notification.
const MENTION = /(^|[^\w.@])@([A-Za-z][\w]{3,31})/g;
const unmention = (t) => t.replace(MENTION, "$1$2");
// "Iron Grey Owl, esquire" is one person, but a comma in a name splits every list (roll call, say&tag=…):
// the part before the first comma is the name everywhere (user, 25.09.2026).
export const displayName = (n) => n.split(",")[0].trim() || n;

// Telegram message → stored text, or null for noise. Runs at ingestion, one message per invocation.
export function messageText(msg) {
  // GIFs arrive with a `document` too (backward compatibility) — they are noise, not files.
  let text = msg.text ?? msg.caption ?? (msg.photo ? "[фото]" : msg.document && !msg.animation ? "[файл]" : "");
  text = text.replace(EMOJI, "").trim();
  if (!/[\p{L}\p{N}]/u.test(text) || /^\/\w+(@\w+)?$/.test(text)) return null; // stickers, voice, GIFs, "+", "😂", bare /commands
  const o = msg.forward_origin;
  if (o) {
    if (WAR_REPOST.test(text)) return null;
    // Only the fact of forwarding reaches the model, never the text: forwarded words ended up in the forwarder's mouth,
    // their authors became characters, and monitoring jargon leaked as scenery (24.09.2026). War reposts leave no trace.
    const title = (o.chat?.title || o.sender_chat?.title || "невідомо").replace(EMOJI, "").split(" | ")[0].trim().slice(0, 40);
    return o.type === "user" || o.type === "hidden_user" ? "[переслав чуже повідомлення]" : `[переслав допис з ${o.type === "chat" ? "групи" : "каналу"} «${title}»]`;
  }
  return unmention(redact(text.slice(0, 800)).replace(BOT_HANDLE, BOT_NAME)); // ponytail: 800-char cap per message keeps a pasted article from eating the day
}

export const lengthTarget = (n) => (n <= 20 ? [500, 800] : n <= 150 ? [900, 1400] : [1400, 2000]); // a third shorter (25.09.2026)

export const splitChunks = (lines, size = CHUNK) =>
  lines.length <= BIG_DAY ? [lines] : Array.from({ length: Math.ceil(lines.length / size) }, (_, i) => lines.slice(i * size, (i + 1) * size));

export function dedupLoop(text, maxRepeats = 3) {
  // A model stuck in a loop repeats one line hundreds of times; cut at the first sign of it.
  const lines = text.split("\n");
  const seen = new Map();
  for (let i = 0; i < lines.length; i++) {
    const key = lines[i].trim();
    if (!key) continue;
    seen.set(key, (seen.get(key) || 0) + 1);
    if (seen.get(key) > maxRepeats) return lines.slice(0, i).join("\n");
  }
  return text;
}

export function applyFixes(text, reply, { maxOld = 40, maxNew = 60, protectedTerms = [], hedging = SUSPECT_COMMENTARY } = {}) {
  const applied = [], rejected = [];
  for (const line of reply.split("\n")) {
    if (!line.includes("=>")) continue;
    const i = line.indexOf("=>");
    const clean = (s) => s.trim().replace(/^[«»"']+|[«»"']+$/g, "");
    const old = clean(line.slice(0, i)), neu = clean(line.slice(i + 2));
    if (!old || !neu || old === neu || !text.includes(old)) continue;
    // A clean fix is short and literal; hedging is the model thinking out loud. Names, tags and
    // the bot's name look like typos to the model and must never be altered or removed.
    const touchesProtected = protectedTerms.some((p) => (old.includes(p) && !neu.includes(p)) || p.includes(old));
    if (old.length > maxOld || neu.length > maxNew || hedging?.test(neu) || touchesProtected) {
      rejected.push(`${old} => ${neu}`);
      continue;
    }
    text = text.replaceAll(old, neu);
    applied.push(`${old} => ${neu}`);
  }
  for (const [old, neu] of Object.entries(STATIC_FIXES)) if (text.includes(old)) text = text.replaceAll(old, neu);
  text = text.replace(VOCATIVE, "$1Бабцю");
  return { text, applied, rejected };
}

// ponytail: stem-in-chat heuristic — a metaphor slips through on a day a member wrote the same word.
export const warWords = (play, chat) => [...new Set((play.match(WAR_WORDS) || []).map((w) => w.toLowerCase()))].filter((w) => !chat.toLowerCase().includes(w));

// Grumbles (user, 13.10.2026, second round): the 08:00 morning one, silence till the 13:00 play and till 15:00, then ONE grumble
// at a random half hour 15:00–19:00; and exactly one random phrase a day in the same window — Lida's tease with a meat picture
// on odd days, Сусід's phrase on even ones (the GIFs are manual only now). The ticks come from the date itself, so there's
// nothing to store; scheduled() also claims every tick in D1, so a second cron delivery can't post it twice (13.10: two
// grumbles at 17:00 and 17:01). (Was a fixed 17:00 grumble till 13.10, every 3.5 h till then, every 2 h till 10.10.)
// 20:00–08:00 she is silent: the evening has the 21:00 poll and the 22:00 play (user, 25.09.2026).
// ponytail: one-off (user, 30.09.2026, out of neurons) — silent till 22:30, then the evening play; the poll is sent by hand
// (/run?kind=poll&to=group, ~20:00) and closed at 02:00 next night. Drop after 30.09.
export const ONE_OFF = { day: "2026-09-30", quietUntil: 22 * 60 + 30, evening: 22 * 60 + 30 }; // minutes of the day
export const oneOff = (day) => (day === ONE_OFF.day ? ONE_OFF : null);
export const GRUMBLE_SLOTS = [480]; // the fixed one; the afternoon one is grumbleMinute(day)
export const MIDDAY_QUIET = [13 * 60, 15 * 60]; // after the 13:00 play nothing till 15:00
const HOT_MIN = 30, QUIET_MAX = 2; // ponytail: messages in the last 90 min; tune on the real group
const WINDOW = Array.from({ length: 9 }, (_, i) => 900 + i * 30); // 15:00–19:00
const dayNo = (day) => Date.parse(day) / 864e5;
const phraseKind = (day) => (dayNo(day) % 2 === 1 ? "підколка" : "сусід");
const phraseMinute = (day, kind) => (phraseKind(day) === kind ? WINDOW[(dayNo(day) * 7) % WINDOW.length] : null);
export const teaseMinute = (day) => phraseMinute(day, "підколка");
export const neighbourMinute = (day) => phraseMinute(day, "сусід");
// The afternoon grumble: any window tick but the phrase's.
export const grumbleMinute = (day) => { const free = WINDOW.filter((m) => m !== (teaseMinute(day) ?? neighbourMinute(day))); return free[(dayNo(day) * 5 + 3) % free.length]; };

// One run per key (13.10.2026: two grumbles at 17:00 and 17:01, doubled pictures — a cron tick or a webhook delivered twice).
// The first run to insert the key wins; fails open, so a missing `ticks` table can't silence the bot. Old keys go with it.
export async function claim(db, key, now = Date.now()) {
  const ts = Math.floor(now / 1000);
  try {
    const r = await db.prepare("INSERT OR IGNORE INTO ticks (key, ts) VALUES (?, ?)").bind(key, ts).run();
    await db.prepare("DELETE FROM ticks WHERE ts < ?").bind(ts - 3 * 86400).run();
    return r.meta.changes > 0;
  } catch (e) {
    console.log("claim:", e.message);
    return true;
  }
}
// What the cron owes at a Kyiv day and minute of the day — the one schedule, read by scheduled() and by plan.mjs
// (30.09.2026: a hand-copied plan.mjs would drift). Runtime guards (≥50 messages, already done, stock size, TEASE set,
// no grumble right under a play) stay in scheduled().
export const MIDDAY_MINUTE = 13 * 60, POLL_MINUTE = 21 * 60;
export function due(day, m) {
  const o = oneOff(day), hour = Math.floor(m / 60), out = [];
  if (o && m < o.quietUntil) return ["тиша"];
  if (m === 120) out.push("закрити вчорашнє опитування");
  if (m === 210 && new Date(`${day}T12:00:00Z`).getUTCDay() === 1) out.push("хроніка тижня");
  if (m >= 150 && m <= 240) out.push("запас м'яса"); // 02:30–04:00, not the 02:00 tick that closes the poll
  if (m === MIDDAY_MINUTE) out.push("денна п'єса");
  if (hour >= 22 && !o) out.push("закрити опитування");
  if (m >= (o?.evening ?? 22 * 60)) out.push("вечірня п'єса");
  if (GRUMBLE_SLOTS.includes(m) || m === grumbleMinute(day)) out.push("бурчання");
  if (m === neighbourMinute(day)) out.push("сусід");
  if (m === teaseMinute(day)) out.push("підколка");
  if (m === POLL_MINUTE) out.push("опитування");
  return out;
}

export const parseGrumbles = (txt) => {
  const out = {};
  let cur = null;
  for (const l of txt.split("\n").map((x) => x.trim())) {
    if (l.startsWith("## ")) out[(cur = l.slice(3).trim())] = [];
    else if (cur && l && !l.startsWith("#")) out[cur].push(l);
  }
  return out;
};

// recent = null right after a digest: it deleted what it covered, so the count is unknown, not zero.
export const grumbleSection = (minute, recent) =>
  minute === 480 ? "ранок"
  : recent != null && recent >= HOT_MIN ? "гаряче"
  : recent != null && recent <= QUIET_MAX ? "тиша"
  : minute < 660 ? "ранок"
  : minute >= 720 && minute < 840 ? "обід"
  : minute >= 1080 ? "вечір"
  : "загальне";

// Every answer opened "X, ти шо, з …" and the group noticed ("вона повторюється", 24.09.2026). Code picks the move,
// so variety doesn't depend on the model obeying a "don't repeat yourself" line.
// Tone is picked by code too: one answer in three snaps back, two in three answer what was actually said —
// philosophically, with Poderviansky pathos, no insults (user's ratio, 24.09.2026).
export const RUDE_SHARE = 1 / 3;
export const REPLY_TONES = {
  rude: "Тон грубий: відгавкайся, мат доречний, але спершу відповідь по суті, потім лайка.",
  wise: "Тон філософський: відповідай по суті того, що написав автор, — з урочистістю і абсурдом, як мудра бабця на лавці, що бачила все; без образ автора, мат щонайбільше одне слівце для колориту.",
};
export const REPLY_MOVES = {
  rude: [
    "Почни канцеляритом, як офіційне оголошення управдому, — і зірвись на лайку.",
    "Почни з короткого наказу чи поради автору.",
    "Почни з вигуку чи матюка, потім несподівано мудра фраза.",
    "Відповідай одним гострим порівнянням автора з чимось побутовим — без вступу.",
    "Відповідай погрозою в дусі бабці: що вона зробить, якщо автор не вгамується.",
    "Висміюй сказане так, ніби це оголошення на дошці біля під'їзду.",
    "Відповідай, як касирка АТБ наприкінці зміни: коротко, зло й по ділу.",
    "Почни з народного прокляття й закінчи несподівано добрим побажанням.",
    "Прикинься, що доповідаєш дільничному про автора, — сухо й з лайкою.",
    "Відповідай риторичним питанням, яке саме по собі вже образа.",
  ],
  wise: [
    "Почни з філософського узагальнення про життя, двір чи людство.",
    "Почни зі спогаду бабці з вісімдесятих чи дев'яностих — і виведи з нього мораль про те, що написав автор.",
    "Відповідай як бабця, яка зараз прочитає лекцію про суть сказаного.",
    "Відповідай вигаданою народною мудрістю чи приказкою, що несподівано пасує до сказаного.",
    "Зроби вигляд, що не почула, і відповідай про щось своє, бабцине, — але так, щоб це виявилось глибоким коментарем до сказаного.",
    "Відповідай урочистим пророцтвом про двір, АТБ чи людство, що випливає зі сказаного.",
    "Порівняй сказане з рецептом: що туди кинути, скільки варити й чому все одно пригорить.",
    "Відповідай так, ніби пишеш некролог сказаному — урочисто й абсурдно.",
    "Зведи сказане до однієї дрібної побутової істини й подай її як відкриття століття.",
    "Відповідай як мудрий старець із казки, але зі словником бабці з лавки.",
    "Почни з маминої науки й доведи її до абсурду.",
    "Дай пораду, як із цим жити далі, — корисну, але так, що смішно.",
    "Відповідай, ніби це питання до передачі «Здоров'я» чи «Поле чудес», і ведуча — ти.",
    "Знайди у сказаному щось зворушливе й поплач над цим по-бабциному, з урочистістю.",
    "Відповідай тостом за столом: піднімай чарку за сказане й несподівано заверши.",
    "Зроби зі сказаного прогноз погоди на завтра для всього двору.",
    "Відповідай листом до редакції газети «Вечірній Київ» 1987 року.",
    "Поміркуй, що про це сказав би Сковорода, якби жив біля АТБ.",
    "Відповідай загадкою, відповідь на яку — сам автор чи сказане.",
    "Перекажи сказане як велику історичну подію, про яку внуки читатимуть у підручнику.",
  ],
};

// "В неї троха фетиш на голубів" (24.09.2026): every reply and every play opened with pigeons, ЖЕК and маршрутка,
// the prompts' own examples. Code now picks the image, one per reply and one per play.
export const IMAGES = [
  "черга в поліклініку", "пенсійний фонд", "базар на Виноградарі", "тролейбус без світла", 
  "Нова пошта й загублена посилка", "турецький серіал о сьомій", "акція в АТБ на ковбасу",
  "дача й колорадські жуки", "ліфт, що застряг між поверхами", "лічильник за воду", "сусідський кіт", "лавка біля під'їзду",
  "батареї, які не гріють", "шлюб у РАЦСі в дев'яностих", "тиск і тонометр", "бабусин сервант із кришталем",
  "килим на стіні", "олів'є на Новий рік", "трилітрова банка з огірками", "радіоточка на кухні", "черга за хлібом",
  "квитанція за газ", "дзеркало в передпокої", "тапки біля дверей", "гречка про запас", "чайний гриб у банці",
  "прання в тазику", "кросворд у газеті", "лото на дачі", "бабусина скриня", "сусідка з собачкою",
  "шуба в нафталіні", "пляшка кефіру з зеленою кришкою", "табуретка на кухні", "городня лопата", "курси валют на базарі",
  "весілля в їдальні", "стара «Волга» в гаражі", "похід у баню", "мішок картоплі на балконі",
  "відривний календар", "пральна машина «Малютка»", "рецепт медовика", "дідова вудка", "розсада на підвіконні",
  "черга в собес", "тролейбусний квиток", "аптечка з зеленкою", "сусідський перфоратор", "молочна кухня",
];

// The model echoed its hints into the chat ("ПРИЙОМ: Синку Lida…", "ОБРАЗ: лавка біля під'їзду", 24.09.2026):
// labels are cut, and a line that only repeats the image goes.
const HINT_LABEL = /^\s*(?:ПРИЙОМ|ОБРАЗ|ПІДКАЗКА|[^\n:«»]{1,40} пише)\s*:\s*/iu; // ОБРАЗ ДНЯ, ОБСЯГ: whole lines, in tidy
export const stripHints = (text, image = "") =>
  text.split("\n").map((l) => l.replace(HINT_LABEL, ""))
    .filter((l) => l.trim() && l.trim().replace(/[.!]$/, "").toLowerCase() !== image.toLowerCase()).join("\n").trim();

// The answer is a reply, so naming the author is noise ("Ivan M, ще при Кучмі…", 24.09.2026). Full name, the part
// before a comma ("Iron Grey Owl") and the first word are cut wherever they stand, then punctuation is mended.
// The name she calls the addressee by (user, 29.09.2026: "answer by name if there's a link"): the first form in ALIASES,
// written as the exact address ("Тарасе", "Олю") — the model made "Івану" of "Іван". A shared form is fine here:
// the reply goes to one person anyway (user, 30.09.2026: both Nina are "Олю", both Oleksandrs "Сашко").
export const callName = (aliases, name) => aliases.get(name)?.[0] ?? "";

export function dropName(text, name) {
  const forms = [...new Set([name, name.split(",")[0], name.split(" ")[0]].map((f) => f.trim()).filter((f) => f.length >= 3))];
  for (const f of forms.sort((a, b) => b.length - a.length)) {
    // Whole word only: "Тарасе, …" (the vocative she is told to use) lost "Тарас" and went out as "Е, …" (30.09.2026).
    text = text.replace(new RegExp(`^\\s*${esc(f)}(?![\\p{L}])\\s*[,:—-]?\\s*`, "iu"), "").replace(new RegExp(`\\s+${esc(f)}(?![\\p{L}])(?=\\s*[,!?.:—]|$)`, "giu"), "");
  }
  text = text.replace(/,\s*([,!?.])/g, "$1").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Who is a woman comes from config (FEMALE_NAMES in wrangler.toml — real names stay out of the code). A name matches
// if it equals an entry or contains it as a word, emoji ignored: "Nora 🐸 Frog" matches "Nora". Everyone else is a man.
const words = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}. ]+/gu, " ").split(/\s+/).filter(Boolean);
export const femaleSet = (csv = "") => csv.split(",").map((n) => words(n).join(" ")).filter(Boolean);
export const isFemale = (name, set) => {
  const w = words(name), full = w.join(" ");
  return set.some((f) => f === full || (!f.includes(" ") && w.includes(f)));
};
// One line for the secretary and the writer: the model can't tell Lida from Denys by the name alone (24.09.2026).
export const genderLine = (names, set) => {
  const women = [...new Set(names)].filter((n) => isFemale(n, set));
  return women.length ? `СТАТЬ: жінки — ${women.join(", ")}; решта — чоловіки. Узгоджуй рід і звертання.\n\n` : "";
};

// "@бабця + word" — a word from a topic turns the answer to it; a bare tag gets the general answer. First match wins.
// Lunch only 12:00–14:00 Kyiv (user's rule, 24.09.2026); outside it such a tag gets the general answer.
// Hints name no concrete places or objects: the model copied "на акції в АТБ, у колясочній" into all 8 samples.
const W = (stems) => new RegExp(`(?<![\\p{L}])(?:${stems})`, "iu");
// "Продовжи вірш" (08.10.2026): an imperative verb of continuing and a noun about verse or song within two words of each
// other — "продовжимо розмову" and "закінчи роботу" must not fire. "далі" alone is not a command (owner).
const VERSE_VERB = "продовжи(?:ть)?|продовжуй(?:те)?|продовж(?![\\p{L}])|продолжи|продолжай|допиши(?:ть)?|дописуй(?:те)?|добий(?:те)?|добей|закінчи(?:ть)?|закінчуй(?:те)?|закончи|доверши(?:ть)?|дороби";
// "рядок/рядки" alone is an everyday word ("допиши рядок коду"): it counts only as "рядки вірша/пісні…" or when the lines
// follow on the next line ("доверши рядки:\n…").
const VERSE_NOUN = "віршик|вірш|стишок|стишк|стих(?![\\p{L}])|стихи|куплет|строф|рядк\\p{L}*\\s+(?:вірш|пісн|стих|куплет)|рядк\\p{L}*(?=[^\\p{L}\\n]*\\n\\s*\\p{L})|пісн|песн|частушк|частівк";
export const VERSE_CMD = W(`(?:${VERSE_VERB})[^\\p{L}]+(?:[\\p{L}']+[^\\p{L}]+){0,2}?(?:${VERSE_NOUN})`);
// "Підбери риму до слова": a request for a rhyme — the word itself comes from rhymeTarget().
const RHYME_NOUN = "рим[уаи](?![\\p{L}])|рифм[уаи]?(?![\\p{L}])";
// "Рима" is also the city in the genitive ("дай квиток до Рима", "від Рима до Парижа"): a preposition right before the noun
// rules a rhyme request out. (A bare "покажи мені Рима" still passes — the owner's chat has no way to tell it from "риму".)
const NOT_AFTER_PREP = "(?<!(?:^|[^\\p{L}])(?:до|від|із|з|про|біля|на|в|у|під|над|без|за)\\s)";
export const RHYME_CMD = W(`(?:підбер|підбир|знайд|придума|дай|скажи|покажи|шукай)[\\p{L}']*[^\\p{L}]+(?:[\\p{L}']+[^\\p{L}]+){0,2}?${NOT_AFTER_PREP}(?:${RHYME_NOUN})|зарифмуй|римуй|${NOT_AFTER_PREP}(?:${RHYME_NOUN})[^\\p{L}]+(?:до|на|для)(?![\\p{L}])`);
// Every topic answers the question first: "розклади таро, чи виграє збірна України" got three stock cards about
// the building, not a word about the team (25.09.2026). Hints carry no concrete examples — the model copies them.
// Russia and a strike both named anywhere in the text (lookaheads: order does not matter).
// What every form of the "удар по РФ" hint shares: decide who hit whom, joy only at objects and the state, no war words.
const STRIKE_CORE = "спершу з'ясуй за повідомленням, ХТО по кому вдарив. Якщо наші (Сили оборони, дрони) уразили Росію, її завод, склад, аеродром чи ППО — радій на повну, урочисто й гучно, як на свято. Якщо вдарили по Україні — не радій і не жартуй, скажи коротко й стримано. Радість лише про об'єкти, техніку й державу: ні слова про загиблих, цивільних чи національність. Воєнних слів (війна, фронт, обстріл, битва, терор) не вживай ні як метафору, ні для опису — кажи просто «долетіло», «горить», «спалахнуло». Деталі (місто, завод) бери з повідомлення, нічого не вигадуй.";
const STRIKE_FORMS = [
  "форма — тост: підніми чарку за те, що долетіло.",
  "форма — вирок їхньому ППО: воно в тебе дірявіше за сито.",
  "форма — прокляття заводові й державі, урочисте, на три ступені.",
  "форма — новина дня, як її передає бабця на лавці: з придихом і подробицями з повідомлення.",
  "форма — бабусине пророцтво: що тепер у них там не буде ні пального, ні спокою.",
];
// Ukrainian and Russian, plus the chat's slang for the other side ("рашка", "кацапи", "москалі", "орки"): these only switch
// the topic on; the hint still keeps jokes off people and nationality.
const RU_CITY = "омськ|омск|белгород|бєлгород|курськ|курск|брянськ|брянск|краснодар|новоросійськ|новороссийск|ростов|воронеж|саратов|татарстан|єлабуг|елабуг|москв|москов|кремл";
const RU_WORD = "рф(?![\\p{L}])|росі|россі|російськ|российск|москал|рашк|рашист|кацап|русн|мордор|орк(?![\\p{L}])|орки|орків|орками|нпз|нафтопереробн|нефтеперераб|нафтобаз|нефтебаз";
// Ukrainian places that make a strike "on us"; the genitive "України" is left out on purpose: "Сил Оборони України" sits in
// every report of our own strikes.
const UA_PLACE = "одеськ|одещин|одеса|одесі|одесу|одесс|київ|києв|киев|харків|харк|дніпр|днепр|запоріж|запорож|львів|львов|миколаїв|миколає|николаев|херсон|полтав|сумщин|сумськ|сумах|сумы|чернігів|чернігов|чернигов|черкас|вінниц|винниц|житомир|кропивниц|хмельниц|рівне|рівного|рівному|луцьк|тернопіл|тернопол|ужгород|кременчук|кривий ріг|кривому розі|кривого рога|краматорськ|слов'янськ|куп'янськ|покровськ|україну|україні|україною|украину|украине";
const HIT = "приліт|прильот|прилет|прилёт|прилетіл|уразил|уражен|поражен|поцілил|влучан|влучил|попал|попадан|бпла|беспилотн|дрон|вибух|взрыв|горить|горять|горит|горят|палає|палають|пожеж|пожар|ппо|пво|удар|вдар|атакува|атаков|атаку|атак[аи](?![\\p{L}])|ракет|бавовн|бахн|бахк|хлопок|хлопнул|хлопнуло|знищил|знищен|уничтож|збил|збит|сбил|сбит|налет|наліт";
const has = (words) => `(?=[\\s\\S]*(?<![\\p{L}])(?:${words}))`;
const strikeRe = () => new RegExp(`^${has(`${RU_CITY}|${RU_WORD}`)}${has(HIT)}`, "iu");
// A strike on Ukraine: a Ukrainian place and a hit, and no Russian city (then it is more likely ours hitting them).
const hitUaRe = () => new RegExp(`^(?![\\s\\S]*(?<![\\p{L}])(?:${RU_CITY}))${has(UA_PLACE)}${has(HIT)}`, "iu");
const REPLY_TOPICS = [
  // "Продовжи вірш" (08.10.2026): the start comes from verseStart(); a missing start never reaches the model.
  { key: "продовж", long: true, verse: true, temp: 1.0, re: VERSE_CMD,
    hint: "Тема — продовження вірша чи пісні. Нижче в ПОЧАТКУ є чужі рядки: напиши ЛИШЕ продовження, 4–8 нових рядків, одразу після останнього рядка початку. Збережи римування, лад і того, до кого звертаються; рядки тієї ж довжини, що в початку: у римованих рядках кількість складів має збігатися. Риму шукай серед іменників чи прикметників, не дієслів («любити–робити» не годиться); слів заради рими не вигадуй — кожен рядок має сенс і правильну граматику. Рядки початку не повторюй і нічого не пояснюй. Далі по-подерв'янськи: серйозний тон раптом з'їжджає в гротеск і абсурд, суржик, а останній рядок — несподіваний вибух. Мату щонайбільше одне легке слівце. Без заголовка, лапок, вступу й коментаря після. Якщо початок — пісня чи частівка, тримай куплетну будову й повертайся до приспіву, повторюючи його рядки точно, якщо він є в початку." },
  { key: "рима", verse: true, temp: 1.0, re: RHYME_CMD,
    hint: "Тема — підбір рими до слова з дужок. Перший рядок: лише 4–6 справжніх українських слів-рим до нього через кому, без пояснень і без самого слова. Далі двовірш (2 рядки) у стилі Подерв'янського, де кінці рядків римуються: те слово і одна з перелічених рим. Мату щонайбільше одне легке слівце. Більше нічого." },
  // "дай рецепт оладків на молоці" got a joke about an old TV (25.09.2026): a request gets the real thing, in her voice.
  { key: "рецепт", long: true, re: W("рецепт|як приготув|як зварит|що приготув|шо приготув|що зварит|шо зварит|что приготов|что свари|як спект|як засол|як посол|як зробит|как пригот|как свар|как испеч|как засол|как сдела"),
    hint: "Тема — рецепт: дай СПРАВЖНІЙ робочий рецепт того, що просять: інгредієнти з кількістю й 3–6 коротких кроків, рядками. По-бабциному — з бурчанням на початку й одним жартом наприкінці, але рецепт має бути правильний. Тон м'який, але в стилі Подерв'янського: урочистість на рівному місці, суржик, легкі беззлобні підколки («ледащо», «руки-гачки», «недоварена моя»), мату — щонайбільше одне легке слівце, без справжніх образ." },
  // "розкажи анекдот" got a grumble about why jokes don't matter (30.09.2026): a request for a joke gets a real one —
  // set-up and a punchline in the last line; the form is picked by code so they don't repeat.
  { key: "анекдот", long: true, re: W("анекдот|анегдот|розкажи жарт|розкажи щось смішн|пожартуй|пошути|шутку(?![\\p{L}])|розсміш"),
    hint: [
      "Тема — анекдот: розкажи СПРАВЖНІЙ анекдот — коротку історію з зав'язкою й несподіваною кінцівкою в останньому рядку, 3–7 рядків. Класичний зачин «Приходить … до …». Героїв вигадай (без імен сусідів із чату), кінцівку не пояснюй. Одразу анекдот — без вступу перед ним і без висновку чи моралі після кінцівки.",
      "Тема — анекдот: розкажи СПРАВЖНІЙ анекдот-діалог двох вигаданих персонажів з двору, 3–7 рядків, репліки з тире, остання репліка — несподівана кінцівка. Не пояснюй жарт. Одразу анекдот — без вступу перед ним і без висновку чи моралі після кінцівки.",
      "Тема — анекдот: розкажи СПРАВЖНІЙ анекдот на тему того, про що зараз розмова в чаті, — коротка історія з несподіваною кінцівкою в останньому рядку, 3–7 рядків, герої вигадані. Не пояснюй жарт. Одразу анекдот — без вступу перед ним і без висновку чи моралі після кінцівки.",
      "Тема — анекдот: розкажи СПРАВЖНІЙ старий анекдот, як бабця чула його ще в молодості, переказаний її словами, 3–7 рядків, кінцівка в останньому рядку. Не пояснюй жарт. Одразу анекдот — без вступу перед ним і без висновку чи моралі після кінцівки.",
      "Тема — анекдот на три повтори: двічі все йде однаково, а втретє навпаки — у цьому кінцівка; 4–7 рядків, герої вигадані. Не пояснюй жарт. Одразу анекдот — без вступу перед ним і без висновку чи моралі після кінцівки.",
    ] },
  // 14 more formats (user, 30.09.2026: "штук 30, щоб була варіативність"). Narrow triggers, placed before the broad
  // "плітки" («розкажи…») and "порада" («підкажи…», «порадь…»), so each takes only its own requests.
  { key: "спір", re: W("розсуди|розсудіть|рассуди|рассудите|хто прав|кто прав|хто з нас прав|хто виграв суперечк|хто переміг у суперечц"),
    hint: "Тема — суд бабці: розбери суперечку з розмови — позиція кожного одним рядком, потім вердикт: хто правий і чому, урочисто, як суддя на лавці. Переможця назви прямо." },
  { key: "вибір", re: W("що краще|шо краще|что лучше|обери(?!\\s+карт)|вибери(?!\\s+карт)|выбери(?!\\s+карт)|що вибрати|шо вибрати|что выбрать"),
    hint: "Тема — вибір: першим словом назви, що бабця обирає з того, що запропонували, далі один-два рядки чому — з побутовим аргументом. Не ухиляйся й не кажи «обидва»." },
  { key: "кіно", long: true, re: W("що подивит|шо подивит|что посмотр|який фільм|який серіал|фільм на вечір|серіал на вечір|що почитат|шо почитат|что почитат|яку книжк|яку книгу|що пограт|у що пограт|во что поигр|яку гру(?![\\p{L}])"),
    hint: "Тема — що подивитись, почитати чи у що пограти: назви 2–3 СПРАВЖНІ відомі назви саме того, що просять (з автором чи роком, якщо знаєш), до кожної — один рядок бабциної рецензії. Нічого не вигадуй: лише назви, що існують." },
  { key: "прізвисько", re: W("прізвиськ|прозвищ|кличк|придумай ім|як мене назвати|як його назвати|як її назвати"),
    hint: "Тема — прізвисько: придумай три варіанти прізвиська для того, про кого просять, — з того, чим він відомий у дворі й що каже в розмові; без зовнішності, здоров'я й образ. Третій — найсмішніший." },
  { key: "підсумок", long: true, re: W("що я пропустив|шо я пропустив|что я пропустил|що було в чаті|шо було в чаті|про що ви тут|о чем вы тут|перекажи чат|коротко що тут"),
    hint: "Тема — що пропустив автор: 3–5 коротких рядків про головне з РОЗМОВИ ПЕРЕД ЦИМ — про що говорили й чим скінчилось, як бабця з лавки переказує; без оцінок людей і без вигадок." },
  { key: "байка", long: true, re: W("розкажи історі|розкажи байк|як було раніше|як було при союз|в молодості|у молодості|в твоїй молодост|за совка|при совках"),
    hint: "Тема — бабцина байка з молодості: історія від першої особи з радянського двору чи заводу, 5–8 рядків, з конкретною деталлю й кінцівкою, що пасує до того, про що спитали." },
  { key: "загадка", re: W("загадк|загадай(?!\\s+бажан)|вікторин|викторин|ребус"),
    hint: "Тема — загадка: загадай одну загадку в риму чи з підступом, з побуту двору; окремим останнім рядком «Відгадка: …»." },
  { key: "прокляття", re: W("прокляни|прокляніть|прокльон|благослови|благословення|наврочи|пороблен|порчу"),
    hint: "Тема — народне прокляття чи благословення, як просять: 2–4 рядки урочисто, по-бабциному, з побутовими карами чи дарами — смішно, без справжньої злоби, здоров'я й смерті." },
  { key: "насвари", re: W("насвари|посвари|обізви|облай|вилай|нагримай|розбери по кісточк|приструнь"),
    hint: "Тема — насвари: по-сусідськи насвари того, кого просять, за те, що він робить у розмові, — урочисто й смішно, без зовнішності, здоров'я й справжніх образ; наприкінці бабця все одно його жаліє." },
  { key: "комплімент", re: W("компліме|похвали(?![\\p{L}])|похваліть|похвалить|скажи щось приємне|скажи шось приємне|скажи что-то приятное"),
    hint: "Тема — комплімент: похвали того, кого просять, за те, чим він відомий у дворі й що робить у розмові, — щиро, по-бабциному, з одним смішним порівнянням." },
  { key: "слово", re: W("(?:що|шо) означає(?!\\s+(?:ц[еяі]й?|це|цей|ця|ці|для|то)(?![\\p{L}]))|что означает(?!\\s+(?:эт|для))|що значить слово|шо значить слово|что значит слово|поясни слово|розтлумач слово"),
    hint: "Тема — що означає слово: поясни значення слова чи мему, про яке питають, — спершу справжнє значення одним реченням (якщо це місцеве слово двору — як його тут вживають), далі бабцин коментар." },
  { key: "заява", long: true, re: W("напиши заяв|напиши скарг|напиши лист|напиши оголошенн|склади заяв|склади скарг"),
    hint: "Тема — офіційний папір: напиши те, що просять (заяву, скаргу, лист чи оголошення), канцелярським стилем радянської установи: шапка, «Прошу…» чи «Доводжу до відома…», 4–8 рядків, дата й бабцин підпис." },
  { key: "пісня", long: true, re: W("заспівай|пісн(?:ю|я|і)(?![\\p{L}])|пісеньк|песн[юяи](?![\\p{L}])|частушк|частівк|колискову"),
    hint: "Тема — пісня: заспівай куплет і приспів (6–10 рядків у риму) про те, що просять, як бабця співає на лавці; у дужках — одна ремарка, як вона співає." },
  { key: "план", re: W("чим зайнят|план на (?:день|вечір|вихідн)|куди піти|куди сходит|куда сходить|що робити на вихідн|шо робити на вихідн"),
    hint: "Тема — план: розпиши авторові план на те, про що питає, 3–5 пунктів із часом, побутово й абсурдно, останній пункт — неодмінно до бабці на лавку." },
  // Horoscopes and fortune-telling on request (25.09.2026): code picks the kind each time, so they don't repeat.
  // A verse, a toast, a greeting (for the addressee if it's a reply to someone) — a format, not a one-liner (26.09.2026).
  { key: "вірш", long: true, re: W("вірш|стишок|стишк|стихотвор|стих(?:и|ами)?(?![\\p{L}])|тост(?:а|ом|и)?(?![\\p{L}])|привіта|поздрав|з днем народж|с днем рожд|з днюх|с днюх|частушк|пісеньк|песенк"),
    hint: "Тема — те, що просять: вірш (4–8 рядків у риму), тост (урочисто, з чаркою) чи привітання (побажання, спогад і добре прокляття-побажання наприкінці). Про того, кого чи що просять, урочисто, як на шкільній лінійці, з раптовим суржиком і влучним матом." },
  // Dreams: "мені наснилось…", "розтлумач сон" (26.09.2026).
  { key: "сон", long: true, re: W("сонник|наснил|приснил|снилос|снився|снилас|сниться|розтлумач"),
    hint: "Тема — сонник: розтлумач сон автора за бабциним сонником — кожен символ зі сну: що він означає, і наприкінці урочисте абсурдне пророцтво." },
  { key: "таро", long: true, re: W("таро|tarot"),
    hint: "Тема — таро: розклади три карти з бабциної колоди на те, про що спитали. Карти вигадай щоразу нові, побутові й пов'язані з питанням (без карт із минулих відповідей); для кожної — що вона каже саме про це питання. Наприкінці — пряма відповідь на питання (так / ні / коли) і абсурдна порада. Урочисто, як справжня гадалка." },
  { key: "гадання", long: true, re: W("погада|гадання|гадалк|поворож|ворож|кавов\\p{L}* гущ|по долон|на картах|розклад"),
    hint: [
      "Тема — гадання на кавовій гущі: що бабця побачила в чашці (три фігури з побуту) і що вони віщують.",
      "Тема — гадання по долоні: лінія життя, серця й «лінія комуналки» — що кожна каже про автора, абсурдно.",
      "Тема — гадання на картах, як у вісімдесятих: розклад на короля, даму й валета з двору — хто що задумав.",
      "Тема — народне ворожіння на воску чи на цибулі: що вилилось чи проросло і що це значить.",
      "Тема — ворожіння на бобах, як бабця вчилась у свекрухи: скільки бобів ліворуч, скільки праворуч і що з цього.",
    ] },
  { key: "гороскоп", long: true, re: W("гороскоп|зодіак|зірк|астролог|ретроград|меркурі"),
    hint: [
      "Тема — гороскоп на сьогодні: де застрягли планети (місце бери з теми порівняння, не з АТБ і не з колясочної) і чого остерігатись.",
      "Тема — гороскоп на тиждень: коротко по днях, від понеділка до неділі, у 4–7 рядків, абсурдно.",
      "Тема — любовний гороскоп: що зірки кажуть про кохання автора — урочисто й без пошлості.",
      "Тема — фінансовий гороскоп: гроші, пенсія й акції в АТБ за розташуванням зірок.",
      "Тема — гороскоп для всього двору: кожному знаку по пів рядка, знаки вигадай сама — щоразу нові.",
    ] },
  { key: "обід", from: 12, to: 14, re: W("обід|обіда|пообіда|їсти|жерти|пиріж|борщ|вареник|котлет|голодн|їжа|їжу"),
    hint: "Тема — обід: поклич автора обідати, скажи, що в тебе на плиті й чому він мусить прийти негайно." },
  { key: "хахалі", re: W("хахал|кавалер|залиця|кохан|любов|заміж|жених|ухажер|роман[иа]?(?![\\p{L}])|дід|дєд"),
    hint: "Тема — хахалі: розкажи коротко про одного зі своїх колишніх кавалерів (вигаданого, з дев'яностих чи вісімдесятих) — з деталлю, від якої смішно." },
  { key: "погода", re: W("погод|дощ|спек|холод|сніг|вітер|мороз"),
    hint: "Тема — погода: дай прогноз за якоюсь бабциною домашньою прикметою — щоразу іншою." },
  { key: "гроші", re: W("пенсі|грош|ціни|цін[аиу]|акці|зарплат|комуналк|кредит|долар|гривн"),
    hint: "Тема — гроші й пенсія: побурчи про ціни, пенсію й комуналку — з одним абсурдним розрахунком." },
  { key: "здоров'я", re: W("тиск|лікар|таблет|здоров|болить|аптек|поліклін|хвор"),
    hint: "Тема — здоров'я бабці: розкажи про свій тиск, коліна чи таблетки — як про подвиг. Про здоров'я автора не жартуй." },
  // A hit on Russia (owner, 08.10.2026): the tag, or the message it replies to, names Russia and a strike. One regex cannot tell
  // who hit whom ("росія атакувала дронами"), so the hint makes the model decide first and stay silent about hits on Ukraine.
  // A strike on Ukraine goes first (08.10.2026): "Росія атакувала дронами Одещину" names Russia too, and the first answer to it
  // joked about the fire. plain = no lexicon, no tone, no comparison: a short sober reply.
  { key: "удар по Україні", plain: true, temp: 0.7, re: hitUaRe(),
    hint: "Тема — удар по Україні: відповідь — НЕ БІЛЬШЕ ДВОХ коротких речень. Жодних жартів, порівнянь, образів, лайки й прокльонів: це наше лихо. Одне речення — співчуття своїми словами (на кшталт «Ой лихо, бережіть себе»), друге, якщо треба, — суть із повідомлення. Без зловтіхи, без слів про зраду, без воєнних слів (війна, фронт, обстріл, битва, терор), без вигаданих деталей, імен і цифр — лише те, що є в повідомленні. Не називай винних, не лютуй." },
  { key: "удар по РФ", re: strikeRe(),
    hint: STRIKE_FORMS.map((form) => `Тема — удар по Росії: ${STRIKE_CORE} ${form}`) },
  // Before "порада" and "плітки" ("порадуйте", "розкажи"): "розкажіть шось хороше" (25.09.2026) — Ukrainian and Russian: хороше/хорошее, приємне/приятное, порадуйте, втіште/утешьте…
  { key: "хороше", re: W("хорош|приємн|приятн|позитив|радіс|радост|порадуй|порадувати|порадовать|втіш|утеш|потіш|тепле|тепл[оеі]го|добре слово|доброе слово|(?:щось|шось|що-небудь|что-то|чтото|что-нибудь|шото) добр"),
    hint: "Тема — щось хороше: розкажи коротку теплу історію з двору чи зі свого життя, або світлу дрібницю, що може потішити, — без політики й війни. Бабця бурчить для порядку, але серце в неї добре: автора не лай, закінчи несподіваним теплим панчлайном. Тон м'який, але в стилі Подерв'янського: урочистість на рівному місці, суржик, легкі беззлобні підколки («ледащо», «руки-гачки», «недоварена моя»), мату — щонайбільше одне легке слівце, без справжніх образ." },
  // "тег + совет / порада / порекомендуй…" (25.09.2026): Ukrainian and Russian, a different kind of advice each time.
  // If they asked about something concrete, the advice is about exactly that.
  { key: "порада", re: W("порад|порекоменд|рекоменд|що робити|шо робити|як бути|підкаж|посовіту|совіту|совет|посовет|совєт|посовєт|присовєт|подскаж|что делать|шо делать|как быть|допоможи|помоги"),
    hint: [
      "Тема — порада: життєва порада з бабциного досвіду — корисна, але смішна. Якщо спитали про щось конкретне — саме про це.",
      "Тема — порада з побуту: справжня робоча хитрість (пляма, хліб, сусіди, комуналка — або те, про що спитали), з бурчанням.",
      "Тема — «три правила бабці»: три короткі пункти про те, що спитали (чи про життя взагалі), третій абсурдний.",
      "Тема — порада, як у журналі «Робітниця» 1987 року: урочисто, канцеляритом, про те, що спитали.",
      "Тема — порада-притча: коротка історія з бабциного життя з мораллю наприкінці, що пасує до питання.",
    ] },
  { key: "плітки", re: W("пліт|новин|що нового|шо нового|розкажи|хто там"),
    hint: "Тема — плітки: переказуй «новини двору» загально й вигадано, без імен і реальних фактів про людей." },
  { key: "пророцтво", re: W("що буде|шо буде|завтра|передбач|пророк|майбутн"),
    hint: "Тема — пророцтво: передбач авторові чи двору щось урочисте й абсурдне." },
];
// "@бабця + surname" — fixed answers, word for word as the user set them (24.09.2026); checked before topics and fire
// wherever the name stands in the message. "порох" and "моль" are ordinary words too (gunpowder, moth), so they count
// only when the message is that one word.
const WE = (stems) => new RegExp(`(?<![\\p{L}])(?:${stems})(?![\\p{L}])`, "iu"); // whole words, for short or ambiguous stems
const FIXED_REPLIES = [
  // angles: what she goes on about when the tag has more than the name — directions, not lines to copy (user, 26.09.2026).
  { re: W("зеленськ|зеленск|зелю|зєл[юяі]|zelensk"), alt: WE("зеля|зелі|зелька|зелик|зе"), text: "заїбав вже",
    angles: "знову не бачив, як навколо крадуть; знову кудись полетів; знову відмазує друзів; грає в теніс з Єрмаком" },
  // Any form, anywhere in the message ("Порох топчик… @бабця нє?" got the general answer, 29.09.2026); always word for word.
  // "порох" is gunpowder too: the idiom "порох у порохівницях" stays out.
  { re: W("порошенк|poroshenk|петр[оау] олексійович"), alt: /(?<![\p{L}])(?<!(?:нема|немає|пахне|пахло|запахло)\s+)(?:порох|пороха|пороху|порохом|порохові)(?![\p{L}])(?!\s+[ув]\s+порох)(?!\s+(?:пахне|пахло|запахло|тхне))/iu, text: "найкращій президент", always: true },
  { re: W("ющенк|yushchenk"), alt: WE("ющ|юща|ющу|ющем|ющеві"), text: "так" },
  { re: W("путін|путин|путлер|пуйл|бункерн|putin"), alt: WE("ввп|хуйло"), only: ["моль"], text: "хуйло",
    angles: "знову несе хуйню; знову погрожує всьому світу; сидить у бункері й боїться власної тіні" },
  { re: W("трамп|трумп|trump|рудий|рудого|рудому|рижий|рыжий|рыжего"), text: "шизік",
    angles: "знову дуріє; бомбив Іран; тягне гроші звідусіль; вводить мита на все підряд" },
  { re: W("д[іи][\\s-]?дже[йяюєї]"), alt: WE("dj"), text: "в світі існує лише один комуніст, достойний поваги. Прізвище його - Коваленкий!" },
  // Whole surname forms only: "Федорівна" (patronymic) and "Федір" (first name) must not trigger.
  { re: WE("федоров|федорова|федорову|федоровим|федорові|федорів|федорових|fedorov"), text: "роль кібербезпеки трохи перебільшена" },
  { re: W("(?:бре+д+|брэ+д+|bra+d+)\\p{L}*[\\s-]*(?:пі+т+|пи+т+|пє+т+|pi+t+)"), text: "справжній мущина" },
];
export const fixedFor = (text) => {
  const t = text.replace(/@\w+/g, "");
  const bare = t.replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
  return FIXED_REPLIES.find((f) => f.re.test(t) || f.alt?.test(t) || f.only?.includes(bare)) || null;
};
// Just the name ("@бабця трамп") → the fixed phrase alone. More than the name ("шо там трамп?") → the phrase stays the
// opening and the model goes on about what was asked: "шизік, знов дуріє…" (user, 26.09.2026).
export const fixedIsBare = (text) => {
  let t = text.replace(/@\w+/g, "");
  if (FIXED_REPLIES.some((f) => f.only?.includes(t.replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase()))) return true; // "порох" alone
  for (const f of FIXED_REPLIES) for (const re of [f.re, f.alt].filter(Boolean)) t = t.replace(new RegExp(`${re.source}\\p{L}*`, "giu"), " ");
  return !/\p{L}{2,}/u.test(t);
};

export const topicFor = (text, hour) =>
  REPLY_TOPICS.find((t) => (t.from == null || (hour >= t.from && hour < t.to)) && t.re.test(text.replace(/@\w+/g, ""))) || null;
// The tag alone says nothing ("@бабця шо скажеш" under a news post): the replied-to message or the forwarded post can carry
// the topic. Only this one topic reads them; any other keeps to the tag's own words.
const STRIKES = REPLY_TOPICS.filter((t) => t.key === "удар по Україні" || t.key === "удар по РФ");
export const strikeFor = (...texts) => { const t = texts.filter(Boolean).join("\n"); return STRIKES.find((s) => s.re.test(t)) ?? null; };
// The tag's own topic wins ("порадь", "вірш"); with none, or only "плітки" ("розкажи про це", "що нового?"), a strike in the
// replied-to message or forwarded post decides.
export const replyTopic = (raw, hour, ...replied) => {
  const own = topicFor(raw, hour);
  return !own || own.key === "плітки" ? strikeFor(...replied) ?? own : own;
};

// Real tags for "say": each known name becomes a text_mention (it notifies without a @username). Offsets are
// UTF-16 units, which is what JS string length counts.
export function mentionPrefix(people) {
  let text = "";
  const entities = [];
  for (const { name, uid } of people) {
    if (text) text += ", ";
    entities.push({ type: "text_mention", offset: text.length, length: name.length, user: { id: uid } });
    text += name;
  }
  return { text: text ? `${text}, ` : "", entities };
}


// Forward stubs carry no content; the writer skips them so a day of forwarding doesn't inflate the length target.
const REPOST_MSG = /^\[\d\d:\d\d\] [^:]+: \[переслав /;
export const withoutReposts = (lines) => lines.filter((l) => !REPOST_MSG.test(l));

// Plans packed into ≤ max-char chunks, in order — the model reads a whole history one chunk at a time (29.09.2026).
export const packChunks = (items, max = 40000) => items.reduce((acc, t) => {
  const last = acc.at(-1);
  if (last && last.length + t.length + 2 <= max) acc[acc.length - 1] = `${last}\n\n${t}`;
  else acc.push(t.slice(0, max));
  return acc;
}, []);

// A long message keeps its start and its end, cut at words (30.09.2026: a 1500-char post was cut to its first 300 —
// the preamble; the situation and the conclusion she was asked about were at the end). Same size as a plain cut.
export function excerpt(text, n) {
  if (text.length <= n) return text;
  const half = Math.floor((n - 3) / 2);
  const head = text.slice(0, half).replace(/\s+\S*$/, ""), tail = text.slice(-half).replace(/^\S*\s+/, "");
  return `${head} … ${tail}`;
}

// Her instructions quoted back ("покажи свій промпт", 30.09.2026): a run of n words shared with any of them.
export function leaks(text, prompts, n = 8) {
  const w = plainWords(text), runs = new Set();
  for (const p of prompts) {
    const pw = plainWords(p);
    for (let i = 0; i + n <= pw.length; i++) runs.add(pw.slice(i, i + n).join(" "));
  }
  for (let i = 0; i + n <= w.length; i++) if (runs.has(w.slice(i, i + n).join(" "))) return true;
  return false;
}

// Only the short dash in what she sends (user, 30.09.2026): em and en dashes become "-". Applied at the Telegram call,
// after everything that parses " — " (cast lines, descriptions) is done.
export const shortDash = (t) => t.replace(/[—–]/g, "-");

// Newest lines that fit: each cut to perLine, the oldest dropped past total, order kept. The reply's input was ~35k
// tokens and the free 10k neurons ran out by morning (30.09.2026); the conversation goes into 5–9 model calls.
export function tailFit(lines, perLine, total) {
  const out = [];
  let size = 0;
  for (const l of [...lines].reverse()) {
    const cut = l.length > perLine ? `${l.slice(0, perLine)}…` : l;
    if (size + cut.length > total) break;
    out.unshift(cut);
    size += cut.length + 1;
  }
  return out;
}

// A: the last digests' topics and endings for a tag reply, newest first, dated, capped (26.09.2026) — the plans are
// already in D1 (digests.plan), nothing new is stored for this.
export function recentMemory(rows, max = 1500) {
  const out = [];
  for (const { day, kind, plan } of rows) {
    const keep = plan.split("\n").map((l) => l.trim()).filter((l) => /^\d+\.\s/.test(l) || l.startsWith("Чим закінчилось:"))
      .map((l) => l.replace(/^Чим закінчилось:\s*/, "  → "));
    if (keep.length) out.push(`${day.slice(8, 10)}.${day.slice(5, 7)} ${kind === "midday" ? "вдень" : "ввечері"}:\n${keep.join("\n")}`);
  }
  return out.join("\n").slice(0, max);
}

// Topic titles and endings of the previous digest, so the secretary recognises continuations.
export const prevContext = (plan) => {
  const keep = plan.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("ЧАСТИНА ") || /^\d+\.\s/.test(l) || l.startsWith("Чим закінчилось:"));
  return keep.length ? `КОНТЕКСТ ПОПЕРЕДНЬОГО ВИПУСКУ (уже переказано; лише щоб упізнати продовження):\n${keep.join("\n").slice(0, 2500)}\n\n` : "";
};

// Last line of defence for the two metaphors the model reaches for most; only if the LLM fix left them.
// ponytail: fixed case forms, other war words rely on the LLM fix alone.
const WAR_FALLBACK = [
  [/(?<![\p{L}\p{N}_])терор(ом|у)?(?![\p{L}])/giu, (_, e) => ({ ом: "свавіллям", у: "свавілля" })[e?.toLowerCase()] || "свавілля"],
  [/(?<![\p{L}\p{N}_])війн(а|и|у|ою|і)(?![\p{L}])/giu, (_, e) => ({ а: "колотнеча", и: "колотнечі", у: "колотнечу", ою: "колотнечею", і: "колотнечі" })[e.toLowerCase()]],
];
// Her tics (03.10.2026, screenshot evidence/replies/pafos-tic-03-10.webp): "пафосу, ніби ти тут …, а на деле …" twice in
// a row and "завтра у всьому дворі буде такий …, шо навіть …" — the prompt's own word "пафос" echoed back. A draft with
// a tic loses to any draft without one, before the judge; a tic the author wrote himself doesn't count.
// The rest came from her last 80 replies (03.10.2026, logs/said-last80.json): ", блядь, а отже" in 40, "це як намагатися"
// in 38 — one frame "X — це як намагатися …: шуму, блядь, на …, а на виході / а толку — …, а отже — …". "а отже" was
// asked for by reply.txt and the judge; that ask is gone. The drafts with the fewest tics go on to the judge.
// 08.10.2026: the frame returned as "це така ж безглузда затея, як намагатися …" (2 of 2 replies after the lexicon deploy,
// 1 of 83 before), which "це як намагат" missed — so the tic is the verb phrase alone.
// 11.10.2026 (user's newlogic.md): "абсурд", "парадокс" and the opener "Ім'я, твоє X - це …" (both 10.10 screenshots start so) are tics too.
// 10.10.2026: "це така велична й безглузда метафізика, як намагання …" (2 of 2 screenshots): "як намагання", the "така X і Y" pair and the word "метафізика" are tics too.
const TICS = [/(?<![\p{L}])пафос/iu, /ніби ти тут/iu, /на деле(?![\p{L}])/iu, /завтра\s+(?:на|у|в)\s+(?:весь|всьому|усьому|цілому|цілий)\s+двор/iu,
  /(?<![\p{L}])а отже(?![\p{L}])/iu, /(?<![\p{L}])намаг/iu, /(?<![\p{L}])така\s+(?:ж\s+)?[\p{L}]+\s+(?:і|й)\s+[\p{L}]+/iu, /метафізик/iu, /(?<![\p{L}])(?:абсурд|парадокс)/iu, /^[\p{L}'’-]+,\s+(?:твій|твоє|твоя|твої|твого|твою)\s[^,.!?]{0,60}?\s[-—–]\s/iu, /(?<![\p{L}])шуму(?![\p{L}])/iu, /а толку/iu, /а на виході/iu, /,\s*де замість/iu, /мандахуй/iu];
export const ticky = (t) => TICS.some((re) => re.test(t)); // her own past replies with a tic are not shown back to her: they bred more of it
const ticCount = (d, asked) => TICS.filter((re) => re.test(d) && !re.test(asked)).length;
export const ticFree = (drafts, asked) => {
  const least = Math.min(...drafts.map((d) => ticCount(d, asked)));
  return drafts.filter((d) => ticCount(d, asked) === least);
};

// "(5)" after a tag reply (04.10.2026): how many more full replies the free neurons allow. The limit is taken as the
// last 24 hours, not a UTC day (seen twice 30.09; Cloudflare's docs say 00:00 UTC — rolling is the stricter of the two).
// Both plays fall in any 24 h ahead, so for each one: what is spent in the 24 h before it (rows that slid out no longer
// count), the plays up to it, and the small daily stuff pro rata, must leave room. Measured: a play with poster
// ≈ 2–2.5k (13.10.2026 from the spend table: midday ≈ 1.2k, evening ≈ 1.2–1.5k, so 1800 with a margin), a full reply ≈ 400 (30.09.2026). ponytail: OTHER_NEURONS is a guess — grumbles, Сусід, tease, night stock.
export const NEURONS_DAY = 10000, PLAY_NEURONS = 1800, REPLY_NEURONS = 400, OTHER_NEURONS = 800, PLAY_HOURS = [13, 22];
export function repliesLeft(rows, nowMs, offsetSec) {
  const DAY = 864e5, next = (h) => {
    let t = Math.floor(nowMs / DAY) * DAY + h * 36e5 - offsetSec * 1000 - DAY;
    while (t <= nowMs) t += DAY;
    return t;
  };
  const room = PLAY_HOURS.map(next).sort((a, b) => a - b).map((t, i) => NEURONS_DAY
    - rows.filter((r) => r.ts * 1000 > t - DAY).reduce((s, r) => s + r.neurons, 0)
    - PLAY_NEURONS * (i + 1) - OTHER_NEURONS * (t - nowMs) / DAY);
  return Math.max(0, Math.floor(Math.min(...room) / REPLY_NEURONS));
}

export const warFallback = (play, chat) =>
  WAR_FALLBACK.reduce((s, [re, fn]) => s.replace(re, (m, e) => (chat.toLowerCase().includes(m.toLowerCase()) ? m : fn(m, e))), play);

// The «Дійові особи» block as lines (header first) through fn; no block → the play as is.
const editCast = (play, fn) => {
  const start = play.indexOf("Дійові особи:");
  if (start < 0) return play;
  const end = play.indexOf("\n\n", start), stop = end < 0 ? play.length : end;
  // "Дійові особи: A, B та інші." on the header line (14.10.2026) was taken for the header itself and never cleaned.
  const lines = play.slice(start, stop).replace(/^Дійові особи:[ \t]+(?=\S)/, "Дійові особи:\n").split("\n");
  return play.slice(0, start) + fn(lines).join("\n") + play.slice(stop);
};

// A member who speaks but is missing from «Дійові особи» (Nina, 24.09.2026) gets a neutral line there. Only real
// senders are checked, so a stray "Висновок:" never becomes a character.
export const castFix = (play, names) => editCast(play, (lines) => {
  const cast = new Set(lines.slice(1).map((l) => nameKey(castName(l))));
  const add = names.filter((n) => !cast.has(nameKey(n)) && new RegExp(`^${esc(n)}(?: \\([^)\\n]*\\))?:`, "m").test(play))
    .map((n) => n); // a bare name: "— голос із натовпу" read as a label (29.09.2026)
  const others = lines.findIndex((l) => l.startsWith("та інші"));
  return others < 0 ? [...lines, ...add] : [...lines.slice(0, others), ...add, ...lines.slice(others)];
});

// «Дійові особи» line = "Name «tag» — role in today's story": the tag is the member's real one, put there by code;
// the model writes only the role. "Lida — ковбаска, яка знає ціну репутації" hurt (24.09.2026): if the role
// still leans on the tag, it goes and "Name «tag»" stays. Matched by 5-letter stems of every tag word, since the
// model inflects ("сардельку"); a tag without a 4+ letter word ("Нік2") is matched whole; "Тюлєчка, форшмак" is two
// nicknames, any one counts. Title and scenes may play with tags — a joke.
// The model drops commas and emoji from names ("Iron Grey Owl esquire", 24.09.2026): names are compared
// without case, emoji and punctuation, and the cast gets the full name back.
const nameKey = (s) => s.replace(EMOJI, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
const CAST_LINE = /^(.+?)(?:\s*«[^»\n]*»)?(?:\s[—–-]\s(.+))?$/;
const castName = (l) => l.match(CAST_LINE)[1].replace(/;\s*$/, "").trim();
const leansOnTag = (desc, tag) => tag.toLowerCase().split(",").some((t) => {
  const words = t.match(/\p{L}+/gu) ?? [];
  const stems = words.some((w) => w.length >= 4) ? words.map((w) => w.slice(0, 5)) : [t.trim()];
  return stems.every((w) => desc.toLowerCase().includes(w));
});
export function castClean(play, tags, names = []) {
  const real = new Map([...names, ...tags.keys()].map((n) => [nameKey(n), n]));
  // One line per member: "Danylo «Бубон»" and "Hnat «Бубон»" both stood in the cast (02.10.2026) — the described one stays.
  // 07.10.2026: "Kit Kotsky, Bohdan, …, Ivan M, Бабця з альтанки." stood in the cast as one more line — a list of
  // everybody with no description and no "та інші" for castShuffle to catch. Two or more real names split by commas = a list.
  const isList = (l) => !l.match(CAST_LINE)[2] && !/[tт][aа]\s+інші/iu.test(l) && l.split(",").filter((p) => real.has(nameKey(p))).length >= 2;
  return editCast(play, (lines) => {
    const out = lines.filter((l) => !isList(l)).map((l) => {
      const name = real.get(nameKey(castName(l))), desc = l.match(CAST_LINE)[2];
      if (!name) return { l };
      const tag = tags.get(name), d = desc && !(tag && leansOnTag(desc, tag)) ? desc : "";
      return { l: name + (tag ? ` «${tag}»` : "") + (d ? ` — ${d}` : ""), name, d };
    });
    return out.filter((x, i) => !x.name || out.findIndex((y) => y.name === x.name && (y.d || !x.d)) === i).map((x) => x.l);
  });
}

// «Дійові особи» in a new order every time, "та інші мешканці двору" stays last (user, 25.09.2026).
export const castShuffle = (play, rnd = Math.random) => editCast(play, ([head, ...body]) => {
  // The model once wrote "ta інші" in Latin letters and it got shuffled into the middle (29.09.2026); on 02.10.2026 it
  // wrote "Hnat, Petro, … Danylo та інші." — a list of everyone, shuffled in as one more "member".
  const isRest = (l) => /^[tт][aа]\s+інші/iu.test(l) || (!l.match(CAST_LINE)[2] && /,.*\s[tт][aа]\s+інші/iu.test(l));
  const rest = body.some(isRest) ? ["та інші мешканці двору"] : [], cast = body.filter((l) => !isRest(l));
  for (let i = cast.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [cast[i], cast[j]] = [cast[j], cast[i]];
  }
  return [head, ...cast, ...rest];
});

// Everyone who wrote but isn't named anywhere in the play gets a roll-call remark before the moral, so nobody
// finds out they "wrote nothing today" ("А я сьогодні ніхуя не писав виходить", 24.09.2026). A name counts as present
// if its part before a comma appears ("Iron Grey Owl" for "Iron Grey Owl, esquire").
// Night 22:00–05:00 opens the midday window and gets its own first scene, or one remark if it was quiet (24.09.2026).
// Only the leading run counts: 22:0x right before an evening digest is not "night".
// ponytail: an evening skipped for <50 messages rolls its window into the next midday, and that night gets no scene.
const NIGHT_SCENE_MIN = 10; // fewer night messages get one remark, not a scene (user, 24.09.2026)
const NIGHT_TITLES = ["Нічна зміна", "Поки двір спав", "Безсоння біля АТБ", "Нічний парламент альтанки"];
export function nightLine(lines) {
  const night = [];
  for (const l of lines) {
    const h = Number(l.slice(1, 3));
    if (!(h >= 22 || h < 5)) break;
    night.push(l);
  }
  if (!night.length) return "";
  const who = [...new Set(night.map((l) => l.match(/^\[\d\d:\d\d\] (.+?): /)?.[1]).filter(Boolean))].join(", ");
  const head = `НІЧ: ${night.length} повідомлень ${night[0].slice(1, 6)}–${night.at(-1).slice(1, 6)}, учасники: ${who}.`;
  return night.length < NIGHT_SCENE_MIN ? `${head} Без сцени — одна ремарка.`
    : `${head} Перша сцена — «${NIGHT_TITLES[Math.floor(Math.random() * NIGHT_TITLES.length)]}».`;
}

// Every member in «Дійові особи» gets a description (user, 30.09.2026: "Mykola.Pr «Нік2»" with none is High — the
// cast says who did what). castBare lists the bare ones, castDescribe puts the model's "Name — опис" lines in.
const castBody = (l, i) => i > 0 && l.trim() && !/^та інші/i.test(l);
export const castBare = (play) => {
  const out = [];
  editCast(play, (lines) => (lines.forEach((l, i) => castBody(l, i) && !l.match(CAST_LINE)[2] && out.push(castName(l))), lines));
  return out;
};
export const castDescribe = (play, answer) => {
  const got = new Map(answer.split("\n").map((l) => l.replace(/^[-•*\s]+/, "").match(/^(.+?)\s*(?:«[^»]*»)?\s*[—–:-]\s*(.{3,80})$/)).filter(Boolean)
    .map(([, n, d]) => [nameKey(n), d.trim().replace(/\.$/, "")]));
  return editCast(play, (lines) => lines.map((l, i) => {
    const d = castBody(l, i) && !l.match(CAST_LINE)[2] && got.get(nameKey(castName(l)));
    return d ? `${l.trimEnd()} — ${d}` : l;
  }));
};

export function rollCall(play, names) {
  const flat = nameKey(play);
  const missing = [...new Set(names)].filter((n) => !flat.includes(nameKey(n.split(",")[0])));
  if (!missing.length) return play;
  const who = missing.length > 12 ? `${missing.slice(0, 12).join(", ")} та ще ${missing.length - 12}` : missing.join(", ");
  return beforeMoral(play, `(Також у дворі галасували: ${who.replace(/\.$/, "")}.)`); // a name ending in "." got ".." (30.09.2026)
}

// The reply judge answers "2 8" — best draft and its score 1–10. Garbage picks the first draft and counts as
// good, so a confused judge never costs a second round.
// The fixed phrase leads exactly once (29.09.2026: the model wrote it itself with "—" for "-", the exact-prefix check
// missed it and the phrase went out twice, "Коваленкий!. В світі існує…"). Any copy, whatever the dashes and
// punctuation, is cut out; the phrase goes first, with no "." after its own "!".
export function leadFixed(text, fixed) {
  const words = fixed.match(/\p{L}+/gu) ?? [];
  const copy = new RegExp(`${words.join("[^\\p{L}]+")}[^\\p{L}\\s]*`, "giu");
  const rest = text.replace(copy, "").replace(/^[\s.,!?:;—–-]+/u, "").trim();
  const head = `${fixed[0].toUpperCase()}${fixed.slice(1)}${/[.!?…]$/.test(fixed) ? "" : "."}`;
  return rest ? `${head} ${rest}` : head;
}

export function parseVote(text, n) {
  const [k, score] = (text.match(/\d+/g) ?? []).map(Number);
  return { best: k >= 1 && k <= n ? k - 1 : 0, score: score ?? 10 };
}

// The model garbles real names: "Ніркослав Коваль" for "Николай Коваль" (25.09.2026) — then the roll call
// also missed him. Every member's name gets its exact spelling back, in plays and replies:
// - two-word names: one word exact, the neighbour a garbled other word (same first letter, similar length) → full name;
// - one-word Latin names of 6+ letters: a word 1–2 edits off with the same first letter → the name.
// Cyrillic one-word names aren't touched: the model declines them («Олександра»), and that's correct.
// ponytail: same-first-letter heuristic — a garbled first letter slips through.
const editDistance = (a, b) => {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
};
// "Nikolay Коваль" for the sender "Николай Коваль" (14.10.2026): the model flips the first name's script, so the first-letter
// check below fails. Same name in another script = transliteration within one edit.
const TR = Object.fromEntries("а:a б:b в:v г:h ґ:g д:d е:e є:ye ж:zh з:z и:i і:i ї:yi й:y к:k л:l м:m н:n о:o п:p р:r с:s т:t у:u ф:f х:kh ц:ts ч:ch ш:sh щ:shch ы:y э:e ю:yu я:ya ь:".split(" ").map((p) => p.split(":")));
const translit = (s) => [...s.toLowerCase()].map((c) => TR[c] ?? c).join("");
// The same member's name in another script or with a suffix is one person (20.10.2026: people_notes had "Oleksandr" and
// "Олександр", "Nikolay Коваль" and "Николай Коваль", "…, esquire" twice, and the second one overwrote a fuller note).
const noteKey = (n) => translit(displayName(n)).replace(/[^a-z0-9]+/g, " ").trim();
export const sameName = (a, b) => { const x = noteKey(a), y = noteKey(b); return x.length >= 4 && (x === y || editDistance(x, y) <= 1 && x[0] === y[0]); };
const otherScript = (w, real) => /\p{Script=Cyrillic}/u.test(w) !== /\p{Script=Cyrillic}/u.test(real);
const garbled = (w, real, known) => w !== real && !known.has(w) && (w[0].toLowerCase() === real[0].toLowerCase()
  && w.length >= real.length / 2 && w.length <= real.length * 2
  || otherScript(w, real) && w.length >= 4 && editDistance(translit(w), translit(real)) <= 1);
// A nickname at the start of a line — a speaker ("Тарас (позіхаючи): …") or a cast line — becomes the Telegram name,
// so castFix and the roll call see the member (29.09.2026: a member's short name sat in the cast undescribed).
// Only a nickname of exactly one of today's senders: "Оля" or "Саша" belong to several and stay as they are.
export function aliasSpeakers(text, aliases, senders) {
  const owners = new Map();
  // A form that is itself a sender's Telegram name ("Олександр") would rename that sender's lines — skipped.
  for (const [name, forms] of aliases) if (senders.includes(name)) for (const f of forms) if (!senders.includes(f)) owners.set(f, owners.has(f) ? null : name);
  // Cast lines too: "Danylo «Бубон» - …" stood next to "Hnat «Бубон»" (02.10.2026).
  return text.replace(/^([\p{L}'’]+)(?=\s*(?:\(|:|«|[—–-]\s|$))/gmu, (w) => owners.get(w) || w);
}

export function fixNames(text, names) {
  const all = [...new Set(names)];
  const known = new Set(all.flatMap((n) => n.split(/\s+/)));
  for (const full of all) {
    const words = full.split(/\s+/).filter((w) => /\p{L}/u.test(w));
    if (words.length >= 2) {
      const [first, last] = [words[0], words.at(-1)];
      if (last.length >= 4) text = text.replace(new RegExp(`(?<![\\p{L}])(\\p{Lu}[\\p{L}'’-]+)\\s+${esc(last)}(?![\\p{L}])`, "gu"),
        (m, w) => (garbled(w, first, known) ? `${words.slice(0, -1).join(" ")} ${last}` : m));
      if (first.length >= 4) text = text.replace(new RegExp(`(?<![\\p{L}])${esc(first)}\\s+(\\p{Lu}[\\p{L}'’-]+)(?![\\p{L}])`, "gu"),
        (m, w) => (garbled(w, last, known) && editDistance(w, last) <= Math.max(2, last.length / 3) ? `${first} ${words.slice(1).join(" ")}` : m));
    } else if (/^[A-Za-z]{6,}$/.test(full)) {
      text = text.replace(/(?<![\p{L}])[A-Za-z]{5,}(?![\p{L}])/gu, (w) => (garbled(w, full, known) && editDistance(w, full) <= 2 ? full : w));
    }
  }
  return text;
}

// A tag inside a reply to another member: is the request for that member? (user's rules, 25.09.2026) Yes when the
// message tags them (@username or a name tag), names them as in Telegram, uses a verb aimed at someone
// ("вразумі", "буль", "заспокой", "видай", "пригости") or a verb + "їй/йому/їм" ("ну скажи їй"). Otherwise the brief decides.
const AIMED = /(?<![\p{L}])(?:вразум|образум|буль(?![\p{L}])|заспокой|успокой|видай|выдай|пригост|угост)/iu;
const AIMED_AT = /(?<![\p{L}])(?:скаж|дай|розкаж|расскаж|поясн|объясн|відповід|ответ|покаж|налий|налей|напиш)\p{L}*\s+(?:їй|йому|їм|ей|ему|им)(?![\p{L}])/iu;
// ALIASES from wrangler.toml → Map(Telegram name → real-life forms): "дай ліді рецепт" as a reply to Lida is for
// Lida, who is Ніна (25.09.2026) — the Telegram name alone can't tell.
export const parseAliases = (s = "") => new Map(s.split(";").map((p) => p.split(":")).filter((p) => p.length === 2)
  .map(([n, forms]) => [n.trim(), forms.split(",").map((f) => f.trim()).filter(Boolean)]));
export function pointsAtOther(text, mentions, other, aliases = []) {
  if (!other) return false;
  const t = text.replace(/@babtsya_z_altanky_bot\b/gi, "");
  if (!/\p{L}/u.test(t)) return true; // a bare tag under someone's message is meant for them (live, 14.10.2026: answered the one who tagged)
  if (mentions.some((m) => (m.id && m.id === other.uid) || (m.username && other.username && m.username.toLowerCase() === other.username.toLowerCase()))) return true;
  if ([...other.name.split(/\s+/), ...aliases].some((w) => /^\p{L}{3,}$/u.test(w) && new RegExp(`(?<![\\p{L}])${w}(?![\\p{L}])`, "iu").test(t))) return true;
  return AIMED.test(t) || AIMED_AT.test(t);
}

// The picture committee: three single-number answers (appetizing, realistic, flawless), averaged to one decimal.
// Garbage answers don't vote; no valid vote at all → null, and the picture isn't stocked.
export function committeeScore(answers) {
  const votes = answers.map((a) => Number(String(a).match(/\d+/)?.[0])).filter((n) => n >= 1 && n <= 10);
  return votes.length ? Math.round((votes.reduce((s, n) => s + n, 0) / votes.length) * 10) / 10 : null;
}

// The play's «title» line, for the evening poster's caption.
export const playTitle = (play) => play.match(/^«[^\n]+»$/m)?.[0] ?? "";

// Code-made remarks (roll call, poll verdict) go right before the moral.
// "(Мораль: …)" in brackets hid the moral from beforeMoral and rollCall — the roll call went after it (30.09.2026).
export const plainMoral = (play) => play.replace(/^\(\s*Мораль\s*:\s*(.+?)\)\s*$/gm, "Мораль: $1");
export function beforeMoral(play, line) {
  const moral = play.lastIndexOf("\nМораль");
  return moral < 0 ? `${play.trimEnd()}\n\n${line}` : `${play.slice(0, moral).trimEnd()}\n\n${line}\n${play.slice(moral)}`;
}

// Replicas the writer copied from the chat instead of writing (25.09.2026: news retold word for word): 6 words in a
// row shared with any chat message. The last replica of a scene may stay verbatim — it's the punchline.
const plainWords = (s) => s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
// Every run of n words in the chat → who wrote it (copiedLines and misattributed read the same map).
function chatRuns(chat, n) {
  const runs = new Map();
  for (const m of chat) {
    const [, who, text] = m.match(/^\[\d\d:\d\d\] ([^:\n]+): (?:\(відповідь [^)]*\) )?(.*)/) ?? [];
    if (!who) continue;
    const w = plainWords(text);
    for (let i = 0; i + n <= w.length; i++) {
      const k = w.slice(i, i + n).join(" ");
      runs.set(k, (runs.get(k) ?? new Set()).add(who));
    }
  }
  return runs;
}
export function copiedLines(play, chat, n = 6) {
  const seen = chatRuns(chat, n);
  const lines = play.split("\n");
  return lines.filter((l, i) => {
    const said = l.match(/^([^\n:]{1,80}): (.+)/)?.[2];
    if (!said || l.startsWith("Мораль")) return false;
    const next = lines.slice(i + 1).find((x) => x.trim()) ?? "";
    if (!next || next.startsWith("(") || next.startsWith("Мораль")) return false;
    const w = plainWords(said);
    for (let k = 0; k + n <= w.length; k++) if (seen.has(w.slice(k, k + n).join(" "))) return true;
    return false;
  });
}

// Words put in the wrong mouth (29.09.2026: Lida got "Волохаті люди красиві і воняють коли давно не миті" — the second
// half was Artem's). A replica whose speaker shares a run of n words with someone else's chat message and with none of
// their own. Speaker names are matched by their start ("Iron Grey Owl" for "Iron Grey Owl, esquire").
export function misattributed(play, chat, n = 5) {
  const runs = chatRuns(chat, n);
  return play.split("\n").filter((l) => {
    const [, speaker, said] = l.match(/^([^\n:(]{1,80}?)\s*(?:\([^)\n]*\))?: (.+)/) ?? [];
    if (!said || /^(Мораль|Дійові|Дія)/.test(speaker)) return false;
    const mine = (who) => who.startsWith(speaker.trim()) || speaker.trim().startsWith(who.split(",")[0]);
    const w = plainWords(said);
    let others = false;
    for (let k = 0; k + n <= w.length; k++) {
      const authors = runs.get(w.slice(k, k + n).join(" "));
      if (!authors) continue;
      if ([...authors].some(mine)) return false;
      others = true;
    }
    return others;
  });
}

// Every label the model sees in its input and could echo back: block headers, plan fields, template slots,
// chat markers, reply hints. Whole lines for headers and fields, the marker itself for inline ones.
const SERVICE_LINE = new RegExp(
  "^\\s*(?:(?:ОБРАЗ ДНЯ|ОБСЯГ|НІЧ|ПЛАН ДНЯ|ЧАТ|СТАТЬ|ПІДПИСИ УЧАСНИКІВ|ТЕМИ|ЩО РОБИВ|КОНТЕКСТ ПОПЕРЕДНЬОГО ВИПУСКУ|ТВОЇ ОСТАННІ РЕПЛІКИ|РОЗМОВА ПЕРЕД ЦИМ|ЩО БУЛО В ДВОРІ[^\\n]*|ХРОНІКА ДВОРУ|РОЗБІР|ХТО Є ХТО|ЧАСТИНА \\d+ з \\d+)(?![\\p{L}]).*" +
  "|(?:Учасники|Тип|Температура|Хронологія|Чим закінчилось|Найкращі фрази|Найкраща фраза)\\s*:.*" +
  "|\\[\\d\\d:\\d\\d\\].*" + // a copied chat line
  "|не надано — день великий.*)$\\n?",
  "gmu",
);
const SERVICE_INLINE = [
  /(?<![\p{L}])(?:КОНФУЗ|ПРОПУСТИТИ)(?![\p{L}])/gu,
  /\((?:відповідь [^)\n]{1,60}|Підказка[^)]*|це відповідь на твоє[^)]*|без тексту[^)]*)\)\s?/giu,
  /\[[^\]\n]{0,80}\]\s?/gu, // [переслав …], [фото], [файл], [12:34] — prose never needs square brackets
  /<[^<>\n]{1,80}>/gu, // template slots: <учасник>, <гротескна характеристика>
];

// A Latin letter hiding inside a Cyrillic word ("обісрaли", 24.09.2026) becomes its Cyrillic twin; a word still mixed
// after that ("маеdеlkа" at t=1.4) is noise and goes.
const HOMOGLYPH = { a: "а", e: "е", o: "о", p: "р", c: "с", x: "х", i: "і", y: "у", A: "А", B: "В", C: "С", E: "Е", H: "Н", I: "І", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х" };
const fixMixed = (t) => t.replace(/\p{L}+/gu, (w) => {
  if (!/\p{Script=Cyrillic}/u.test(w) || !/[A-Za-z]/.test(w)) return w;
  const fixed = w.replace(/[A-Za-z]/g, (c) => HOMOGLYPH[c] || c);
  return /[A-Za-z]/.test(fixed) ? "" : fixed;
});

// Everything the model writes goes through this before Telegram: no pings, no placeholders, no service labels,
// no foreign scripts.
// A stuttered function word ("наче той кіт, що, що у шматочок", 25.09.2026) — the model's glitch, never style.
// ponytail: only short function words; an emphatic "так, так" or "ну-ну" stays.
const STUTTER = /(?<![\p{L}])(що|як|і|й|в|у|на|з|до|та|не|це|бо|же)(?:,?\s+\1)+(?![\p{L}])/giu;
// "сука" became a tic at every reply's end (user, 29.09.2026: "прибери це слово"): cut with its commas; a sentence it
// opened gets its capital back. Other swearing stays — it's her style.
// A sentence start is also after "Name: " and a dash ("Taras: Сука, ти шо?" became "Taras:, ти шо?" — review 30.09.2026).
const noSuka = (t) => t.replace(/,\s*сук[аоу](?![\p{L}])/giu, "")
  .replace(/(^|[.!?…:]\s+|[—–-]\s+)сук[аоу](?![\p{L}])[,!.]?\s*(\p{L})?/gimu, (m, start, next = "") => (next ? start + next.toUpperCase() : start.trimEnd()))
  .replace(/\s*(?<![\p{L}])сук[аоу](?![\p{L}])/giu, "");
// "суцільний …" is her tic ("це просто суцільна, блядь, важка тупизна", 03.10.2026) past the prompt rule and the judge's
// minus two, so the word goes in code; at a sentence start the next word takes the capital.
const noTic = (t) => t.replace(/(^|[.!?…]\s+)суцільн\p{L}*\s+(\p{L})/gimu, (m, start, next) => start + next.toUpperCase())
  .replace(/\s*(?<![\p{L}])суцільн\p{L}*(?![\p{L}])/giu, "");
// 07.10.2026 (screenshots evidence/replies/mandahuy-pafos-07-10.*): "мандахуйова" in four replies of one morning, an invented
// word the prompts never contained — it spread through her own last replies; and "пафос" kept coming back. The owner banned
// both outright, so code swaps them for plain words (same endings, so the grammar holds). Capital letter is kept.
const SWAPS = [[/(?<![\p{L}])пафосн(\p{L}*)/giu, (m, e) => "урочист" + e], [/(?<![\p{L}])пафосом(?![\p{L}])/giu, () => "урочистістю"],
  [/(?<![\p{L}])пафос[уі](?![\p{L}])/giu, () => "урочистості"], [/(?<![\p{L}])пафос(?![\p{L}])/giu, () => "урочистість"],
  [/(?<![\p{L}])мандахуйов(\p{L}*)/giu, (m, e) => "хрінов" + e], [/(?<![\p{L}])мандахуй\p{L}*/giu, () => "хрін"],
  // 13.10.2026 (Lida, "викреслюй оце слово «намагання», від нього вже тошно"): every grumble and answer was "це як намагання …".
  // The word goes by code; ticFree and the filter on her own past replies fight the frame itself.
  [/(?<![\p{L}])намагання(?![\p{L}])/giu, () => "спроба"], [/(?<![\p{L}])намаганням(?![\p{L}])/giu, () => "спробою"], [/(?<![\p{L}])намаганн[іюї](?![\p{L}])/giu, () => "спробі"],
  [/(?<![\p{L}])намагат(?:ися|ись)(?![\p{L}])/giu, () => "пробувати"], [/(?<![\p{L}])намагаюс[яь](?![\p{L}])/giu, () => "пробую"], [/(?<![\p{L}])намагаєшся(?![\p{L}])/giu, () => "пробуєш"],
  [/(?<![\p{L}])намагається(?![\p{L}])/giu, () => "пробує"], [/(?<![\p{L}])намагаємося(?![\p{L}])/giu, () => "пробуємо"], [/(?<![\p{L}])намагаються(?![\p{L}])/giu, () => "пробують"],
  [/(?<![\p{L}])намагайся(?![\p{L}])/giu, () => "пробуй"], [/(?<![\p{L}])намагайтеся(?![\p{L}])/giu, () => "пробуйте"]];
const swapBanned = (t) => SWAPS.reduce((r, [re, to]) => r.replace(re, (...a) => {
  const w = to(...a); return /^\p{Lu}/u.test(a[0]) ? w[0].toUpperCase() + w.slice(1) : w;
}), t);
// Abuse in Poderviansky's manner lives in prompts/curses.txt, one section per theme with word-start triggers. Code hands a
// rude answer three: two from the theme the author's message touches (a second theme gives one), the rest from the general
// section, never one she already used in her last replies — so the vocabulary rotates with the conversation instead of one
// coinage becoming the next tic ("мандахуйова", 07.10.2026). Gender-neutral on purpose: any addressee fits.
const shuffled = (a) => [...a].sort(() => Math.random() - 0.5);
export const parseCurses = (txt) => {
  const out = [];
  for (const l of txt.split("\n").map((x) => x.trim())) {
    if (l.startsWith("## ")) {
      const [name, trig = ""] = l.slice(3).split("|").map((x) => x.trim());
      const stems = trig.split(",").map((x) => x.trim()).filter(Boolean).map((x) => x.replace(/\$$/, "\u0000").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\u0000", "(?![\\p{L}])")); // a trailing $ means the whole word ("друг$" is not "другий")
      out.push({ name, re: stems.length ? new RegExp(`(?<![\\p{L}])(?:${stems.join("|")})`, "iu") : null, items: [] });
    } else if (out.length && l && !l.startsWith("#")) out.at(-1).items.push(l);
  }
  return out;
};
const hitCache = new WeakMap(); // the 3 drafts of one reply ask the same texts: match a text's themes once, not per draft
const themed = (sections, text) => {
  let m = hitCache.get(sections);
  if (!m) hitCache.set(sections, (m = new Map()));
  if (!m.has(text)) { if (m.size >= 4) m.clear(); m.set(text, sections.filter((s) => s.re?.test(text))); }
  return shuffled(m.get(text));
};
const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, " ").trim();
// n phrases from a base: the ask's theme first (n-1 of them, at least one), then one from each other theme the ask or the
// conversation touches, the general section fills the rest; phrases already in her last replies are skipped.
// `ctx` must be bare message bodies (see bodies()): names and group titles gave false theme hits (07.10.2026).
export const pickFrom = (sections, asked = "", ctx = "", recent = "", n = 2) => {
  const used = ` ${norm(recent)} `, picks = [];
  // Matched as whole words with punctuation ignored ("Ото ж бо й воно," inside "Ото ж бо й воно шановний…"); a phrase
  // shorter than 10 characters is never skipped, it would match any reply that happens to contain those words.
  const seen = (c) => { const w = norm(c); return w.length >= 10 && used.includes(` ${w} `); };
  const take = (s, k) => { // walk the shuffled section and stop at k: judging every item for repeats cost ~0.8 ms per hint
    let got = 0;
    for (const c of s ? shuffled(s.items) : []) {
      if (picks.length >= n || got >= k) break;
      if (!picks.includes(c) && !seen(c)) { picks.push(c); got++; }
    }
  };
  const first = themed(sections, asked), rest = themed(sections, ctx).filter((s) => !first.includes(s));
  take(first[0], Math.max(1, n - 1));
  for (const s of [first[1], ...rest]) take(s, 1);
  take(sections.find((s) => !s.re), n);
  return picks;
};
// A short reference on politicians and institutions (13.10.2026, owner: "пополнить базу знаний бабки по политике"): sections
// whose trigger is in the ask (not in the whole chat), at most three, all their lines. Facts for the brief; the model is told
// not to invent beyond them.
export const factsHint = (sections, asked = "") => {
  const hit = sections.filter((s) => s.re?.test(asked)).slice(0, 3);
  return hit.length ? `ДОВІДКА (перевірені факти про тих, кого згадано; бери звідси, а чого тут нема і не знаєш точно — не вигадуй, познач «бабця не певна»; станом на 2026 рік):\n${hit.map((s) => `${s.name}: ${s.items.join(" ")}`).join("\n")}\n\n` : "";
};
export const cursesHint = (sections, asked = "", ctx = "", recent = "") =>
  `Для лайки візьми щось із цього чи вигадай своє в тому ж дусі: ${pickFrom(sections, asked, ctx, recent, 3).map((c) => `«${c}»`).join(", ")}.`;
// One conversation line per message, "Name: text". A multi-line message is folded onto its line, so bodies() can tell a new
// message from a continuation (a continuation line has no "Name: " and was being dropped, or cut at its first ": ").
export const contextLine = (name, text) => `${name}: ${text.replace(/\s*\n\s*/g, " ")}`;
// Only the text of those lines may decide a theme — never a name or a group title.
export const bodies = (context) => context.split("\n").map((l) => l.split(": ").slice(1).join(": ")).join("\n");
const quoted = (a) => a.map((c) => `«${c}»`).join(", ");
const NO_FRAME = ["рецепт", "анекдот", "вірш", "продовж", "рима", "порада"]; // no opener or closer: most of these topics have their own form; "порада" must answer the question itself, a copied opener hijacked it (08.10.2026)
// Colour for a tag reply: words, one opener or closer, a toast/curse only when the ask itself calls for one.
export const lexHint = (bases, { asked = "", ctx = "", recent = "", topic = "" } = {}) => {
  const parts = [], words = pickFrom(bases.lexicon, asked, ctx, recent, 2);
  if (words.length) parts.push(`слова для колориту: ${quoted(words)}`);
  if (!NO_FRAME.includes(topic)) {
    const [label, base] = Math.random() < 0.5 ? ["зачин", bases.openers] : ["кінцівка", bases.closers], f = pickFrom(base, asked, ctx, recent, 1);
    if (f.length) parts.push(`${label}: ${quoted(f)}`);
  }
  const wish = pickFrom(bases.blessings, asked, "", recent, 1);
  if (wish.length) parts.push(`тост чи прокляття: ${quoted(wish)}`);
  return parts.length ? `Для колориту (візьми одне-два чи вигадай своє в тому ж дусі, не всі підряд): ${parts.join("; ")}.` : "";
};
// The start of a verse to continue (08.10.2026): the tagged message's own text (after or before the command), else the
// message it replies to, else her own line it replies to; the last 600 characters, whole lines. null = nothing to continue.
const cutTail = (t, max = 600) => {
  if (t.length <= max) return t;
  let out = "";
  for (const line of t.split("\n").reverse()) { const next = out ? `${line}\n${out}` : line; if (next.length > max) break; out = next; }
  return out || t.slice(-max);
};
export const verseStart = (raw, other, botText) => {
  const clean = raw.replace(/@\w+/g, " "), m = VERSE_CMD.exec(clean);
  const ok = (t) => t.length >= 12 && t.split(/\s+/).length >= 2;
  const tidyLines = (t) => t.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
  const after = m ? tidyLines(clean.slice(m.index + m[0].length).replace(/^[\s:;,.!?\-—–]+/, "")) : "";
  const bare = m ? null : bareParse(raw); // the command is not a line of the verse
  const before = m ? tidyLines(clean.slice(0, m.index)) : tidyLines(bare ? bare.rest.join("\n") : clean);
  const src = [after, before, tidyLines(other?.text ?? ""), tidyLines(botText ?? "")].find(ok);
  return src ? cutTail(src) : null;
};
// A verse or rhyme request: its text may hold words of a fixed phrase ("рудий", a surname) that must not hijack it.
export const isVerseCmd = (raw) => { const t = raw.replace(/@\w+/g, " "); return VERSE_CMD.test(t) || RHYME_CMD.test(t); };
// A bare "продовжи" / "допиши" / "добий" (09.10.2026, live: "@бабця продовжи" under a two-line verse got prose and the tic):
// it is a verse command only when it stands alone on its line, or closes the last line of the verse itself ("…рвати @бабця
// давай продовжи", live 09.10.2026), AND either replies to a message or comes with at least two other lines of text. Only the "keep writing" verbs: "закінчи" / "доверши" / "дороби" are too common outside verse.
const BARE_VERB = "продовжи(?:ть)?|продовжуй(?:те)?|продовж|продолжи|продолжай|допиши(?:ть)?|дописуй(?:те)?|добий(?:те)?|добей";
const BARE_FILL = "ну|ще|давай|далі|будь\\s+ласка|пж|плз|плиз|бабцю|бабко|стара|мені";
const BARE_LINE = new RegExp(`^[^\\p{L}]*(?:(?:${BARE_FILL})[^\\p{L}]+)*(?:${BARE_VERB})(?:[^\\p{L}]+(?:${BARE_FILL}))*[^\\p{L}]*$`, "iu");
const BARE_TAIL = new RegExp(`(?<![\\p{L}])(?:(?:${BARE_FILL})[^\\p{L}]+)*(?:${BARE_VERB})(?:[^\\p{L}]+(?:${BARE_FILL}))*[^\\p{L}]*$`, "iu");
const hasText = (l) => /\p{L}/u.test(l);
// { cmd: the command words, rest: the other non-empty lines (the verse itself) } or null
const bareParse = (raw) => {
  const lines = raw.replace(/@\w+/g, " ").split("\n").map((l) => l.trim()), i = lines.findIndex((l) => BARE_LINE.test(l));
  if (i >= 0) return { cmd: lines[i], rest: lines.filter((l, j) => j !== i && hasText(l)) };
  const last = lines.findLastIndex(hasText), m = last < 0 ? null : BARE_TAIL.exec(lines[last]);
  return m ? { cmd: m[0].trim(), rest: [...lines.slice(0, last), lines[last].slice(0, m.index)].map((l) => l.trim()).filter(hasText) } : null;
};
export const bareVerseCmd = (raw, replied = false) => {
  const b = bareParse(raw);
  return Boolean(b) && (replied || b.rest.length >= 2);
};
export const bareVerseTopic = (raw, replied = false) => bareVerseCmd(raw, replied) ? REPLY_TOPICS.find((t) => t.key === "продовж") : null;
// "@бабця намалюй Хропіллу картинкою" (09.10.2026): a request for a picture never goes through the text chain.
// Imperatives only ("малює" in a story is not a command); the subject is what follows the verb, or the noun in "дай картинку X".
const CYR = "а-яіїєґё'’";
const DRAW_NOUN = "(?:картинк|малюн|зображенн|рисун|изображен|ілюстрац|иллюстрац)[" + CYR + "]*|арт(?![" + CYR + "])";
const DRAW_CMD = new RegExp("(?<![" + CYR + "])(?:"
  + "(?:на|з)?малю(?:й|йте|вати)|(?:на|з)малю(?:єш|єте)"                       // малюй, намалюй, змалюй, намалювати, намалюєш
  + "|(?:на|за)?рису(?:й|йте)|(?:на|за)рису(?:єш|єте|ешь|ете)|(?:на|за)?рисовать"  // рисуй, нарисуй, нарисуйте, нарисуешь, нарисовать
  + "|накида(?:й|йте)|зобрази(?:ти)?|изобрази(?:ть|те)?"            // накидай, зобрази, изобрази
  + "|(?:з|с)генер[" + CYR + "]*\\s+(?:мені\\s+|мне\\s+)?(?:" + DRAW_NOUN + ")"  // згенеруй / сгенерируй картинку
  + "|(?:зроби|сделай|дай|видай|выдай|давай|покажи|кинь|скинь|створи|создай)\\s+(?:мені\\s+|мне\\s+|нам\\s+)?(?:[" + CYR + "]+\\s+)?(?:" + DRAW_NOUN + ")"
  // "кличко в раді. чекаю малюнок" (13.10.2026): no draw verb, a waiting/wanting verb or a leading "малюнок:" is the command
  + "|(?:чека(?:ю|ємо)|жду|ждем|ждём|очікую|хочу|хочемо|прошу|потрібн[" + CYR + "]*|нужн[" + CYR + "]*|треба|надо)\\s+(?:мені\\s+|мне\\s+|нам\\s+)?(?:[" + CYR + "]+\\s+)?(?:" + DRAW_NOUN + ")"
  + "|^\\s*(?:" + DRAW_NOUN + ")\\s*[:—–-]"
  + ")", "iu");
// "скинь йому волохатого вареника" (13.10.2026): a hand-over verb + "йому / їй / мені…" + a thing is a request for the thing's
// picture — unless the thing is a text topic of its own (recipe, joke, advice) or cannot be drawn (a link, a number, money).
const HANDOVER = new RegExp("(?<![" + CYR + "])(?:скинь|скиньте|кинь|киньте|пришли|пришліть|надішли|надішліть)\\s+(?:йому|їй|їм|мені|нам|ним)\\s+(?=[" + CYR + "])", "iu");
const NOT_DRAWN = /(?<![а-яіїєґё'’])(?:гіфк|гифк|мем|посилан|ссылк|номер|пароль|адрес|геолокац|файл|фото|відео|видео|стікер|ключ|гроші|гривн|деньг|рецепт|анекдот|жарт|вірш|стих|пісн|пораду|порад|совет|тост|привітан|загадк|гороскоп|гадан|таро|знати|знать|потім|потом|привіт|привет|грн|дякую|спасибі|відповід|ответ|скоро|пізніше|звістк|новин|інфу|інформаці)/iu;
const handOver = (clean) => { const m = HANDOVER.exec(clean); return m && !NOT_DRAWN.test(clean.slice(m.index + m[0].length)) ? m : null; };
export const isDrawCmd = (raw) => { const clean = raw.replace(/@\w+/g, " "); return DRAW_CMD.test(clean) || Boolean(handOver(clean)); };
// The text that is the picture request: the tag's own words, or — for a bare tag under someone's "намалюй …" — that message
// (owner, 14.10.2026). "" = not a drawing ask.
export const drawAsk = (raw, other = null) => isDrawCmd(raw) ? raw : !/\p{L}/u.test(raw.replace(/@\w+/g, " ")) && other?.text && isDrawCmd(other.text) ? other.text : "";
// Where the picture goes as a reply: a bare tag under someone's "намалюй …" answers that someone (14.10.2026), anything else the tag itself.
export const paintTarget = (raw, other, messageId) => !isDrawCmd(raw) && drawAsk(raw, other) ? other.id : messageId;
export const drawSubject = (raw) => {
  const clean = raw.replace(/@\w+/g, " "), m = DRAW_CMD.exec(clean) || handOver(clean);
  if (!m) return "";
  const rest = (clean.slice(0, m.index) + " " + clean.slice(m.index + m[0].length))
    .replace(/(?<![а-яіїєґ])(?:мені|мне|нам|будь\s+ласка|пожалуйста|плиз|пж|пжлст|на\s+картинці|на\s+картинке|чека(?:ю|ємо)|жду|ждем|ждём|очікую|хочу|хочемо|прошу|потрібн\S*|нужн\S*|треба|надо|картинк\S*|малюнк\S*|рисунк\S*|зображенн\S*|изображен\S*|можеш|можешь|зможеш|сможешь|(?:на|з)?малю\S*|(?:на|за)?рису\S*|(?:на|за)?рисов\S*|накида\S*|ти|ты|збоченк\S*|збоченец|дурн\S*|дурепа|стара|старая|старенька|старенькая|стару|карга|каргa|каргу|кошолк\S*|бабищ\S*|бабця|бабцю|бабко|бабка|бабусю|бабуся|бабушка|бабуля|бабулю|хай|ну)(?![а-яіїєґ])/giu, " ");
  return rest.replace(/\s+/g, " ").replace(/^[\s:;,.!?\-—–]+|[\s:;,.!?\-—–]+$/g, "").slice(0, 200);
};
// "Тебе портрет просять намалювати" (10.10.2026): the model said NO to a self-portrait with an insult in the ask. Her own
// portrait is a fixed scene, never a refusal.
const SELF_PORTRAIT = /(?<![а-яіїєґё])(?:портрет\s+(?:бабц|тебе|себе|твій)|(?:тебе|себе|бабцю|бабку|бабусю)\s+(?:саму\s+)?(?:портрет|намалю)|(?:намалю\S*|малю\S*|нарису\S*)\s+(?:тебе|себе|бабцю|бабусю)|твій\s+портрет|свій\s+портрет)/iu;
export const selfPortrait = (raw) => SELF_PORTRAIT.test(raw.replace(/@\w+/g, " "));
export const SELF_SCENE = "A cheerful grumpy Ukrainian grandmother in a floral headscarf and a knitted cardigan, sitting on a wooden bench in a gazebo by a supermarket, arms folded, with a raised eyebrow and a sly smile; panel apartment blocks behind her. Portrait, fully clothed.";
// Stock refusals she sent herself must not become the "context" of the next ask (10.10.2026).
// The scene model wrote "A realistic portrait of Vitali Klitschko" despite "never photorealism" (13.10.2026): the words are
// swapped by code, so a named public figure always stays a cartoon caricature.
export const cartoonize = (scene) => scene.replace(/\b(?:hyper-?|photo-?)?realistic(?:ally)?\b|\bphoto(?:graph(?:ic|y)?)?\b|\bhyper-?real\b|\bcinematic\b/gi, "cartoon").replace(/\bcartoon(\s+cartoon)+/gi, "cartoon");
// klein answers 3030 "output has been flagged" now and then on a named public figure (13.10.2026, "мера Кличка в раді"):
// the retry gets the same scene without the name — only the described features stay. The name is found after
// "caricature/portrait/… of", leftovers of it ("Klitschko is taller") become "the figure"; nationality words are not names.
const NOT_NAME = new Set(["Eastern", "Western", "European", "Ukrainian", "Slavic", "Russian", "American", "Polish", "Soviet", "Verkhovna", "Rada", "Kyiv", "Kharkiv", "Lviv", "Dnipro", "Odesa"]);
const NAME_AFTER = /\b(?:caricature|portrait|depiction|drawing|illustration|image|figure|cartoon)\s+of\s+((?:[A-Z][a-z'\u2019-]+\s+){1,2}[A-Z][a-z'\u2019-]+)/g;
// Public figures from prompts/politics.txt written the way Gemma writes them in English (several transliterations), so a name is
// caught anywhere in the scene, alone ("Putin stands…") or with a first name, an initial and a title ("President Donald J. Trump").
// Words that are also common ones (Harris, Costa, Kim, Magyar) are left out; "Tusk" and "Fico" only match capitalised.
const SURNAMES = ["Kim Jong Un", "Xi Jinping", "Jinping", "Klitschko", "Klychko", "Zelenskyy", "Zelenskyi", "Zelenskiy", "Zelensky", "Poroshenko", "Yushchenko", "Tymoshenko", "Yanukovych", "Kuchma", "Kravchuk", "Stefanchuk", "Terekhov", "Sadovyi", "Sadovy", "Filatov", "Yermak", "Ermak", "Budanov", "Zaluzhnyi", "Zaluzhnyy", "Zaluzhny", "Syrskyi", "Syrskyy", "Svyrydenko", "Koretskyi", "Koretsky", "Shmyhal", "Umerov", "Khmara", "Fedorov", "Drapatyi", "Lyashko", "Vakarchuk", "Kolomoisky", "Kolomoyskyi", "Akhmetov", "Medvedchuk", "Arestovych", "Trump", "Biden", "Obama", "Putin", "Lukashenko", "Lavrov", "Medvedev", "Shoigu", "Peskov", "Macron", "Merz", "Scholz", "Merkel", "Starmer", "Burnham", "Meloni", "Tusk", "Nawrocki", "Orban", "Orb\u00e1n", "Fico", "Erdogan", "Erdo\u011fan", "Modi", "Netanyahu", "Musk", "Milei", "Lula", "Carney", "Trudeau", "Sheinbaum", "Guterres", "Rutte", "Kallas", "Metsola", "Zhirinovsky", "Navalny"];
// two first names are written as patterns ("Rusl?an", "Volodym?yr"): make-public.sh greps for the literal words, they are also a neighbour's names
const FIRST_NAMES = ["Vitali", "Vitaliy", "Vitaly", "Volodym?yr", "Vladimir", "Petro", "Viktor", "Yulia", "Yuliia", "Julia", "Oleksandr", "Alexander", "Andriy", "Andrii", "Andrey", "Valerii", "Valery", "Rustem", "Mykhailo", "Denys", "Ihor", "Igor", "Donald", "Joe", "Joseph", "Barack", "Elon", "Emmanuel", "Friedrich", "Keir", "Andy", "Giorgia", "Karol", "Robert", "Narendra", "Recep", "Tayyip", "Benjamin", "Javier", "Mark", "Claudia", "Sergey", "Sergei", "Dmitry", "Dmitri", "Oleg", "Svyatoslav", "Sviatoslav", "Rusl?an", "Kyrylo", "Kirill", "Yevhen", "Leonid", "Olaf", "Angela", "Justin", "Luiz", "Alexander"];
const TITLES = ["Prime Minister", "President", "Mayor", "Chancellor", "Minister", "Speaker", "Senator", "General", "Mr", "Mrs", "Ms", "Dr"];
const KNOWN = new RegExp(`(?:\\b(${TITLES.join("|")})\\.?\\s+)?(?:(?:${[...new Set(FIRST_NAMES)].join("|")})\\s+(?:[A-Z]\\.\\s*)?){0,2}\\b(?:${SURNAMES.join("|")})\\b(?:['\u2019]s)?`, "g");
const ESC = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const FIRST_MENTION = ["a person", "another person", "a third person", "a fourth person"];
const LATER_MENTION = ["the first person", "the second person", "the third person", "the fourth person"];
export const namelessScene = (scene) => {
  // names not in the list: "<caricature/portrait/…> of Two Words" and any later mention of one of its words
  const generic = [...scene.matchAll(NAME_AFTER)].map((m) => m[1]).filter((n) => !n.split(/\s+/).some((w) => NOT_NAME.has(w)));
  const extra = [...new Set(generic.flatMap((n) => [n, ...n.split(/\s+/).filter((x) => x.length >= 4)]))].sort((x, y) => y.length - x.length);
  const re = new RegExp(KNOWN.source + (extra.length ? `|\\b(?:${extra.map(ESC).join("|")})\\b(?:['\u2019]s)?` : ""), "g");
  const keyOf = (m) => m.replace(/['\u2019]s$/, "").trim().split(/\s+/).pop().replace(/\.$/, "");
  const keys = [];
  for (const m of scene.matchAll(re)) if (!keys.includes(keyOf(m[0]))) keys.push(keyOf(m[0]));
  const seen = new Set();
  // one person: "a person", then "the figure"; several: told apart ("a person… another person", then "the first person…");
  // "President Putin" keeps the post ("a president"); a possessive stays; a sentence start is capitalised
  const out = scene.replace(re, (m, title, at) => {
    const k = keyOf(m), i = keys.indexOf(k), again = seen.has(k);
    seen.add(k);
    const poss = /['\u2019]s$/.test(m) ? "'s" : "";
    const post = title && !/^(?:Mr|Mrs|Ms|Dr)$/.test(title) ? title.toLowerCase() : "";
    const word = post ? (again ? `the ${post}` : `a ${post}`)
      : keys.length === 1 ? (again ? "the figure" : "a person")
      : (again ? LATER_MENTION : FIRST_MENTION)[Math.min(i, 3)];
    const head = at === 0 || /[.!?]\s*$/.test(scene.slice(0, at));
    return (head ? word[0].toUpperCase() + word.slice(1) : word) + poss;
  });
  return out.replace(/\b(a person|the figure)(,?\s+\1)+\b/g, "$1");
};
export const isFlagged = (message) => /\b3030\b/.test(String(message));
export const isStockPaint = (t) => [...NO_PAINT, ...REFUSE_PAINT].some((x) => t.startsWith(x.slice(0, 25)));
// Stock lines (21.10.2026: 2 + 2 + 3 grew to 10 + 10 + 38, one a day was too repetitive). isStockPaint tells them by the first 25
// chars, so no two NO_PAINT / REFUSE_PAINT lines may start alike (checked in the self-check). The caption gets " (N)" after it.
export const NO_PAINT = [
  "Фарби на сьогодні скінчились, пензлик висох. Проси завтра, бабця ще й не таке намалює.",
  "Бабця сьогодні вже намалювала все, шо могла. Завтра приходь із олівцем.",
  "Мольберт на сьогодні зачинено. Приходь завтра, як фарби привезуть.",
  "Бабця сьогодні вичерпана, як рахунок за світло. Малюнок - завтра.",
  "Пензлик у відпустці до завтра, а бабця при ньому. Не штовхай.",
  "Усі кольори на сьогодні розібрали. Завтра підвезуть, тоді й малюватиму.",
  "Бабця сьогодні вже на нулі: ні фарб, ні сил. Завтра, добре?",
  "Сьогодні мистецтво закрите на переоблік. Приходь завтра.",
  "Тюбики порожні, бабця пуста. Малюнок переноситься на завтра.",
  "Оце ти не вчасно: фарби скінчились. Завтра - будь ласка.",
];
export const REFUSE_PAINT = [
  "Такого бабця не малює - проси шось пристойне, а то пензлик відвернеться.",
  "Ні, оце малювати не буду. Придумай шось людське.",
  "Це бабця малювати не стане - совість не дозволяє. Придумай шось гарніше.",
  "Ні, пензлик такого не торкнеться. Проси про щось людське.",
  "Е ні, оце хай малює хто безсоромніший. Бабця - ні.",
  "На таке бабця фарб не витрачає. Давай інше прохання.",
  "Це ти вже занадто. Кота, квіти, хату - малюватиму, а оце ні.",
  "Бабця має принципи і сухий пензлик. Оце малювати не буду.",
  "Не буде такого малюнка. Скажи шось пристойніше - тоді й поговоримо.",
  "Мій пензлик на таке не підписувався. Проси інше.",
];
export const PAINT_CAPS = [
  "Ось, малювала на колінці - не вередуй.",
  "Тримай шедевр, пензлик ще мокрий.",
  "Намалювала, як побачила. Не подобається - дивись у вікно.",
  "Бабця старалась, аж язик прикусила. Оцінюй мовчки.",
  "Вийшло, як вийшло. Пікассо теж не одразу став Пікассом.",
  "Фарби - останні, нерви - теж. Дивись і радій.",
  "Чесно кажучи, на дев'ять з половиною з десяти. Половину пензлик винен.",
  "Малювала при свічці, бо світло вимкнули. Тому така глибина.",
  "Оце тобі і весь Лувр. Квиток не треба.",
  "Бабця не художниця, бабця - душа. А душа так бачить.",
  "Ось. У рамку не вішай, на холодильник можна.",
  "Малювала-малювала, аж окуляри запітніли. Дивись уважно.",
  "Таку красу тільки на альтанці й побачиш. Лови.",
  "Пензлик тремтів, але бабця не здалась. Результат перед тобою.",
  "На, подавись красою. Бабця ще й не таке вміє.",
  "Оце так, оце шедевр. Скажеш, шо ні - пензлик образиться.",
  "Бабця малює серцем, а серце в мене з характером.",
  "Готово. Підпису не ставлю: скромність дорожча за гроші.",
  "Малювала, поки борщ вистигав. Борщ, до речі, вийшов гірше.",
  "Це не криво, це такий напрям. Сучасне мистецтво, воно таке.",
  "Дивись, поки фарба не висохла. Потім дорожче буде.",
  "Бабця зробила, шо могла. Решту додумай, уява в тебе є.",
  "Пів тюбика пішло на одне небо. Ціни на фарби знаєш?",
  "Малювала сидячи, бо ноги вже не ті. Але рука тримає.",
  "Ось тобі картинка, а мені - слово добре за труд.",
  "Тримай. Якщо шось не так - це не помилка, це задум.",
  "Бабця взяла кольори, шо були. Жовтого, правда, не вистачило.",
  "Старалась, як на конкурс. Журі, на жаль, у відпустці.",
  "Дарую безкоштовно, але вдячність приймаю натурою: пиріжками.",
  "Ну шо ти дивишся? Малювала, як умію. Краще - спробуй.",
  "Оце з першого разу вийшло. Шо мовчиш, де оплески?",
  "Малюнок готовий, бабця втомилась. Каву ставимо?",
  "Тут усе, шо замовляли, і ще трошки від бабці.",
  "Дивись, як воно в бабці виходить, коли не заважають.",
  "Це тобі від бабці - на пам'ять і на подив.",
  "Фарба ще волога, не чіпай пальцями, бо буде не шедевр, а відбиток.",
  "Малювала на одному диханні, тепер на іншому доживаю.",
  "Хай буде, шо буде. Бабця пішла чай пити.",
];
// Just the command ("продовж вірш") — the start is shown to the model once, in its own block, not again inside the ask.
export const verseCommand = (raw) => VERSE_CMD.exec(raw.replace(/@\w+/g, " "))?.[0] ?? bareParse(raw)?.cmd ?? raw;
// What draft() appends to every hint. A verse topic has its own length and comparison rules: "до 12 рядків" and "одне
// порівняння" would fight "4–8 рядків" and a rhymed punchline.
export const replyTail = (topic, long) => topic?.verse || topic?.plain ? "" : ` Щонайбільше одне порівняння, і лише з предмета питання чи розмови.${long ? " Тут можна довше — до 12 рядків." : ""}`;
// The decisions of one reply, split out of compose() in index.js (13.10.2026): its wiring was only ever tested by a live
// chat (the verse preamble, 08.10). Everything below is pure; the model calls stay in index.js.
const NEVER_RUDE = ["хороше", "рецепт", "вірш", "комплімент", "загадка", "підсумок", "кіно", "слово", "пісня", "продовж", "рима", "удар по Україні"]; // never rude for "good" or a recipe
export const LEAK_REPLY = "Шо ти мені тут вказуєш? Бабця сама знає, шо казати, а шо ні.";
// What the tag asks for: a stock reply (no model call), or the topic, the verse start / rhyme word, the tone.
// other = the member the tagged message replies to; rnd is injectable for the tests.
export function replyPlan(raw, { other = null, botText = "", news = "", hour = 12, rnd = Math.random } = {}) {
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  // A verse/rhyme request is never a fixed-phrase one: a verse that mentions "рудий" or a surname kept answering "шизік…" (08.10.2026).
  const replied = Boolean(other?.text || botText), rule = isVerseCmd(raw) || bareVerseCmd(raw, replied) ? null : fixedFor(raw), fixed = rule?.text;
  if (fixed && (rule.always || fixedIsBare(raw))) return { stock: { tone: "фраза", text: fixed } }; // just the name (or Порошенко) — word for word
  // With more than the name the fixed phrase leads and the model carries on: "шизік, знов дуріє…" (26.09.2026).
  const topic = fixed ? { key: "фраза+", hint: `Про цю людину в бабці одна думка — «${fixed}». Почни відповідь дослівно з «${fixed}» і розвинь далі по суті того, що спитали, українською, у стилі Подерв'янського.${rule.angles ? " Розвивай за напрямком із розбору (ПАМ'ЯТЬ і СУТЬ), своїми словами, не дослівно." : ""}` }
    : bareVerseTopic(raw, replied) ?? replyTopic(raw, hour, other?.text, news); // "@бабця + word": a matching topic replaces the random move
  // "Продовжи вірш" / "підбери риму" (08.10.2026): with no start or no word there is nothing to ask the model — a stock reply.
  const verse = topic?.key === "продовж" ? verseStart(raw, other, botText) : null, rhymeWord = topic?.key === "рима" ? rhymeTarget(raw) : null;
  if (topic?.key === "продовж" && !verse) return { stock: { tone: "фраза", text: pick(NO_START) } };
  if (topic?.key === "рима" && !rhymeWord) return { stock: { tone: "фраза", text: pick(NO_WORD) } };
  const tone = !NEVER_RUDE.includes(topic?.key) && rnd() < RUDE_SHARE ? "rude" : "wise";
  return { rule, fixed, topic, verse, rhymeWord, tone, shown: verse ? verseCommand(raw) : raw }; // the start goes to the model once, in its own block, not again inside the ask
}
// The ask the brief, the drafts and the judge all see.
export const replyAsk = ({ name, shown, botText = "", other = null, news = "", pic = "", verse = null, rhymeWord = null }) =>
  `${name} пише: «${shown.slice(0, 500) || "(без тексту — гіфка, стікер чи фото)"}»${botText && !verse ? `\n(це відповідь на твоє: «${excerpt(botText, 300)}»)` : ""}${other && !verse ? `\n(це відповідь на повідомлення ${other.name}: «${excerpt(other.text, 300)}»)` : ""}${news ? `\n(питання про пересланий допис ${news} — відповідай саме про цю новину)` : ""}${pic ? `\n(на фото: ${pic} — якщо питають, що це чи де це, відповідай саме про фото, конкретно)` : ""}${verse ? `\n(ПОЧАТОК, який треба продовжити:\n«${verse}»)` : ""}${rhymeWord ? `\n(слово, до якого шукають риму: «${rhymeWord}»)` : ""}`;
// Whom she answers: the member the tag replies to, when the code (forced) or the brief says so; otherwise the author.
export const replyAddressee = (name, other, brief = "") => other && (other.forced || /Адресат:\s*ІНШ/i.test(brief)) ? other.name : name;
export const addressLines = ({ name, to, woman, call }) => ({
  who: `${to === name ? "Автор" : `Відповідай не автору, а ${to} — звертайся до ${woman ? "неї" : "нього"}. Адресат`} — ${woman ? "жінка: жіночий рід, «доню»" : "чоловік: чоловічий рід, «синку»"}.`,
  byName: call ? ` Звертайся до ${woman ? "неї" : "нього"} дослівно «${call}» — саме в цій формі, не відмінюй і не міняй (раз), а не «${woman ? "доню" : "синку"}».` : "",
});
// The hint inside every draft. A verse gets nothing but its move: who/tone/chat-words invited a comment before the verse
// (live, 08.10.2026). curses and lex are thunks so the gate is decided here.
export function draftHint({ topic, hints = true, who, byName, tone, curses, lex, move, anchor = "", tail = "", bar = "" }) {
  const head = topic?.verse ? "" : `${who}${byName} ${topic?.plain ? "" : `${REPLY_TONES[tone]} `}`;
  const rude = tone === "rude" ? `${curses()} ` : "";
  const words = hints && !topic?.verse && !topic?.plain ? lex() : "";
  return `${head}${rude}${words} ${move}${anchor}${tail}${bar}`;
}
// After the model corrector: the fixed phrase leads once, names are put right, the answer's own name goes, the length is capped.
export function finishReply(text, { fixed = "", names, to, long = false }) {
  if (fixed) text = leadFixed(text, fixed);
  return capReply(dropName(fixNames(text, names), to), long ? 1500 : 500);
}
// Over the cap: back to the last full sentence (if it keeps over half), else the last whole word. A bare slice(0, 500)
// sent "…На ґанку найкраще ду" to the group (13.10.2026).
export function capReply(text, cap) {
  if (text.length <= cap) return text;
  const cut = text.slice(0, cap), end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.endsWith(".") ? cut.length - 1 : -1);
  if (end >= cap / 2) return cut.slice(0, end + 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > 0 ? cut.slice(0, sp) : cut).replace(/[\s,;:—-]+$/, "");
}
// Chronicle lines under a total cap, whole lines only; a long line is cut at a word first (20.10.2026: slice(0, 3000) left "…природності вол"
// as the next chunk's "previous chronicle", and one 1500-char line ate the budget of ten others). Over `max` lines the END goes: the top is
// the long memory (memes, local words), and keeping the newest 20 wiped it out of the 21.10.2026 run (29 lines asked down to 16).
export function capLines(lines, total, per, max = Infinity) {
  const out = [];
  let len = 0;
  for (const l of lines.slice(0, max).map((x) => capReply(x, per))) {
    if (len + l.length + 1 > total) break;
    out.push(l);
    len += l.length + 1;
  }
  return out.join("\n");
}
// One line of the model's notes → [name, note] or null. 21.10.2026: the model echoed the template ("Ім'я: Ivan M: …" made a member
// called "Ім'я"), wrote a row about the bot itself and one about a phantom ("Alex the Fixer: (згадка в контексті …)").
// A name with a colon is a line the lazy regex stretched to the next colon because the note ran over the cap ("Ім'я: Ivan M" was such a row).
export function parseNoteLine(line) {
  const m = line.replace(/[*#_]/g, "").replace(/^\s*[-•]?\s*(?:ім['’ʼ]я\s*:\s*)?/i, "").match(/^(.{2,40}?):\s*(.{5,400})$/);
  if (!m) return null;
  const name = m[1].trim(), note = m[2].trim();
  if (/^ім['’ʼ]я$/i.test(name) || name.toLowerCase() === BOT_NAME.toLowerCase() || name.includes(":") || note.startsWith("(")) return null;
  return [name, note];
}
// One member under two Telegram names ("Main: Other", SAME_PEOPLE, 21.10.2026 — the owner: two names, one person) is one row of
// people_notes and one lookup. Two different people with similar names stay apart (the owner: Mykola.Pr and Олександр).
export const canonName = (name, same) => {
  for (const [main, forms] of same) if (main === name || forms.includes(name)) return main;
  return name;
};
// What goes out: her own instructions never (30.09.2026), a stock line instead of silence.
export const replyOut = (said, leaked, nap) => leaked ? LEAK_REPLY : said || nap;
export const replyTarget = ({ to, name, other, messageId }) => to && to !== name && other ? other.id : messageId; // reply to the member she answers
// Stock replies when there is nothing to ask the model about: a start, or a word to rhyme (0 neurons).
export const NO_START = [
  "А де початок? Я що, ясновидиця? Кинь рядки, тоді й допишу.",
  "Дописувати нічого, а мудрість моя не безмежна. Кидай початок.",
  "Спершу рядки, потім продовження. Така в нас черга, не я вигадала.",
  "Без початку я лише зітхаю. Кинь хоч два рядки.",
  "Що продовжувати, повітря? Рядки давай, тоді й заспіваємо.",
  "Муза без початку не працює, вона в мене з характером. Кинь рядки.",
  "Ой, бабця б продовжила, та нема що. Рядки в студію.",
  "Продовжувати треба щось, а не нічого. Дай початок.",
];
export const NO_WORD = [
  "До якого слова риму шукати? Скажи слово, а не мовчи.",
  "Рими з повітря не ловлю. Дай слово, тоді й підберу.",
  "Риму до чого? Кинь слово, бабця не ясновидиця.",
  "Без слова рима не народжується. Давай слово.",
  "Слово скажи, а не загадки загадуй. Тоді й римуватимемо.",
];
// What the model wrote after the start (08.10.2026): lines that repeat a start line go, at most 8 stay, fewer than 2 = a
// failed draft (null).
const normLine = (l) => l.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
// A refrain may come back (the hint asks a song to return to it): a start line labelled "Приспів…" or given twice in the
// start stays when the model repeats it; any other repeated start line is the model echoing the start and goes.
const REFRAIN = /^\s*(?:приспів|припев|рефрен|chorus)/i;
export const verseTail = (start, out) => {
  const rows = start.split("\n").map((l) => l.trim()).filter(Boolean), count = {};
  for (const l of rows) count[normLine(l)] = (count[normLine(l)] || 0) + 1;
  const had = new Set(rows.map(normLine)), refrain = new Set(rows.filter((l) => REFRAIN.test(l) || count[normLine(l)] > 1).map(normLine));
  // Prose before the verse ("…, як намагатися …. Слухай далі:", live 08.10.2026) is not verse: a line ending in a colon or
  // much longer than the start's longest line goes.
  const cap = Math.max(90, Math.round(1.8 * Math.max(0, ...rows.map((l) => l.length))));
  const lines = out.split("\n").map((l) => l.trim()).filter((l) => l && !l.endsWith(":") && l.length <= cap && (!had.has(normLine(l)) || refrain.has(normLine(l)))).slice(0, 8);
  return lines.length >= 2 ? lines.join("\n") : null;
};
// Rhyme by the last two letters (no stress information): "Марсель/газель", "дарма/нема". Deliberately not weaker (owner).
const onlyLetters = (t) => t.toLowerCase().replace(/[^\p{L}]/gu, "");
const lineEnd = (line) => (line.match(/[\p{L}'’-]+/gu) || []).at(-1) || "";
export const rhymes = (a, b) => {
  const x = onlyLetters(a), y = onlyLetters(b);
  return x.length >= 3 && y.length >= 3 && x !== y && x.slice(-2) === y.slice(-2);
};
// Rhyming pairs among a draft's lines — couplets (AABB) or crossed (ABAB), the better of the two. Used as a preference
// before the judge (like ticFree), never as a rejection: stress and slant rhymes slip past a letters check.
export const rhymeScore = (text, start = "") => {
  const ends = (t) => t.split("\n").map(lineEnd).filter(Boolean);
  // neighbouring lines and lines one apart (AABB and ABAB alike); counted on start + draft minus the start's own pairs,
  // so a draft that closes a rhyme the start left open beats one that only rhymes with itself
  const pairs = (e) => e.reduce((n, w, i) => n + [1, 2].filter((d) => i + d < e.length && rhymes(w, e[i + d])).length, 0);
  return pairs(ends(`${start}\n${text}`)) - pairs(ends(start));
};
export const rhymeFirst = (drafts, start = "") => {
  const top = Math.max(...drafts.map((d) => rhymeScore(d, start)));
  return drafts.filter((d) => rhymeScore(d, start) === top);
};
// The word the continuation must answer: the start's last line ends on a rhyme nobody has closed yet ("…сраку рвати").
// Live 09.10.2026: the model was never told which word to rhyme with, so the reply rhymed only with itself, if at all.
export const rhymeAnchor = (start) => {
  const ends = start.split("\n").map(lineEnd).filter(Boolean), last = ends.at(-1);
  return last && last.length >= 3 && !ends.slice(-3, -1).some((w) => rhymes(last, w)) ? last : null;
};
export const verseAnchorHint = (start) => {
  const w = rhymeAnchor(start);
  return `${w ? ` Перший новий рядок має римуватися зі словом «${w}» (ним закінчується початок).` : ""} Далі римуй парами: рядки 1–2, 3–4 тощо, кінці рядків мають звучати однаково.`;
};
// The word to rhyme (08.10.2026): the first word after "риму / рифму / зарифмуй / римуй" ("до", "на", "слова" skipped).
const NOT_A_WORD = new Set(["мені", "будь", "ласка", "слова", "слово", "слову", "якесь", "якийсь", "яку", "якусь"]);
export const rhymeTarget = (raw) => {
  // A quoted phrase ("добрий вечір") rhymes by its LAST word; unquoted, the first word after the command is the target.
  const m = raw.replace(/@\w+/g, " ").match(/(?:рим[уаи]|рифм[уаи]?|зарифмуй|римуй)(?![\p{L}])[^\p{L}]*(?:(?:до|на|для|слова|слово|слову)\s+)*(?:[«"“]([^»"”\n]{2,40})[»"”]|([\p{L}'’-]{2,}))/iu);
  const w = (m?.[1] ? m[1].trim().split(/\s+/).at(-1) : m?.[2])?.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
  return w && w.length >= 2 && !NOT_A_WORD.has(w.toLowerCase()) ? w : null;
};
// The model's answer for a rhyme request: line 1 is the words (only real rhymes stay, by the last two letters), then the
// couplet. Fewer than two rhymes left or an incomplete couplet = a failed draft (null).
export const rhymeTail = (target, out) => {
  const [first = "", ...rest] = out.split("\n").map((l) => l.trim()).filter(Boolean);
  const good = first.replace(/^[^:\n]{0,15}:\s*/, "").split(/[,;]/).map((w) => w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "")).filter((w) => w && rhymes(target, w));
  return good.length >= 2 && rest.length >= 2 ? [good.join(", "), ...rest.slice(0, 2)].join("\n") : null;
};
// Colour for a grumble: the chat right now (bodies, no names) picks the theme; words and one closer, no swearing.
// A grumble's shape is picked by code (13.10.2026, "фразы повторялись, не по-человечески": both 17:00 grumbles were "це як
// намагання …"): the file said "абсурдне порівняння", so every phrase was one simile. Code hands the form and the length;
// no example phrases here, the model copies those.
export const GRUMBLE_FORMS = ["скарга на одну конкретну дрібницю, без жодного порівняння", "риторичне питання в нікуди", "коротка репліка, ніби кинута впівголоса",
  "спогад «а ось колись…» про те, як було краще", "повчання молодшим, ніби вони завинили", "підсумок дня одним реченням, як у новинах, але по-бабцьому",
  "гукає всім разом з лавки", "наказ усім розійтись або зробити конкретну дрібницю", "здивування, чого це так, і власна дивна версія причини",
  "пророцтво, що з цього вийде найгірше", "переказ того, що їй щойно сказала вигадана сусідка без імені, і її реакція", "бурмотіння про своє — суглоби, тиск, лавка, чай"];
export const GRUMBLE_LENGTHS = ["одне коротке речення, до десяти слів", "два короткі речення", "до двадцяти п'яти слів"];
export const grumbleShape = (withForm = true, rnd = Math.random) => `${withForm ? `Форма: ${GRUMBLE_FORMS[Math.floor(rnd() * GRUMBLE_FORMS.length)]}. ` : ""}Довжина: ${GRUMBLE_LENGTHS[Math.floor(rnd() * GRUMBLE_LENGTHS.length)]}.${withForm ? " Не повторюй хід прикладів." : ""}\n`;
// A new grumble that starts like one of her last lines (the first two words) is the same phrase in a new coat.
const opening = (t) => (t.toLowerCase().match(/\p{L}+/gu) ?? []).slice(0, 2).join(" ");
export const openedLike = (text, lines) => { const o = opening(text); return o.includes(" ") && lines.some((l) => opening(l) === o); };
export const grumbleHint = (bases, chat = "", recent = "") => {
  // 09.10.2026 (user): the grumble draws on all the bases — words, an opener or a closer, and a wish when the chat calls for one.
  const frame = pickFrom(Math.random() < 0.5 ? bases.openers : bases.closers, "", chat, recent, 1), wish = pickFrom(bases.blessings, chat, "", recent, 1);
  const got = [...pickFrom(bases.lexicon, "", chat, recent, 2), ...frame, ...wish];
  return got.length ? `Слова для настрою (візьми одне чи вигадай своє в тому ж дусі, не всі підряд): ${quoted(got)}\n` : "";
};
// Any link is cut from what she writes: one dictated to her in words never goes out (30.09.2026).
export const tidy = (text) =>
  swapBanned(noTic(noSuka(SERVICE_INLINE.reduce(
    (t, re) => t.replace(re, ""),
    fixMixed(unmention(text)).replace(/(?:https?:\/\/|www\.|t\.me\/|(?<![\w@.])[\w-]+\.(?:com|net|org|ua|ru|me|io|xyz|info|site|online|top|link|app|dev)(?![\w]))\S*?(?=[.,;:!?)»]*(?:\s|$))/gi, "…").replace(/\[(?:номер телефону|номер картки|email|посилання)\]/g, "…").replace(/«{2,}/g, "«").replace(/»{2,}/g, "»")
      .replace(/«<([^<>»\n]*)>»/g, "«$1»") // the template's «<назва>» copied verbatim (24.09.2026)
      .replace(SERVICE_LINE, ""),
  )
    // Letters of other scripts ("дешевимกาแฟ" — Thai for coffee, 24.09.2026) are dropped; only Cyrillic and Latin stay.
    .replace(/(?:(?![\p{Script=Cyrillic}\p{Script=Latin}])\p{L}\p{M}*)+/gu, "").replace(/\\?\*+/g, "").replace(STUTTER, "$1") // …and markdown stars ("\\*\\*\\*", 26.09.2026)
  ))).replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n");

// She answers only to her @handle. Words («бабця», «бот»…), replies to her and /commands no longer call her (24.09.2026).
export const addressesBot = (text) => /(?<![\w/])@babtsya_z_altanky_bot\b/i.test(text); // not /cmd@babtsya…

// The form's fixed parts come from code, the model skips them (25.09.2026): "П'єса на одну дію", the opening line
// with the image of the day when the model wrote none, and the night scene's title from nightLine.
// The head (title «…», «Дійові особи») must survive every whole-text rewrite: 02.10.2026 the evening play went out
// starting at "(Сцена 1." — no title, so no poster, and no cast. keepHead puts the old head back on a shortened
// text that lost it; ensureHead gives a play without one an empty cast block (castFix fills it from the speakers)
// and the title, if one is given.
// 11.10.2026: a play came out with bare "(Сцена 1)" headers (no name, no remark) — a shortened text must keep as many named ones.
export const titled = (p) => (p.match(/^\(Сцена \d+\. /gm) ?? []).length;
const sceneAt = (p) => p.search(/^\(Сцена 1\b/m);
export function keepHead(old, short) {
  const o = sceneAt(old), n = sceneAt(short);
  if (o <= 0 || n < 0 || (playTitle(short) && short.includes("Дійові особи:"))) return short;
  return old.slice(0, o) + short.slice(n);
}
export function ensureHead(play, title = "") {
  const at = sceneAt(play);
  if (at >= 0 && !play.includes("Дійові особи:")) play = `${play.slice(0, at)}Дійові особи:\nта інші мешканці двору\n\n${play.slice(at)}`;
  return !playTitle(play) && title ? `«${title.replace(/^«|»$/g, "")}»\n\n${play.trimStart()}` : play;
}

export function stageHead(play, image, nightTitle) {
  if (!play.includes("П'єса на одну дію")) play = play.replace(/\n*Дійові особи:/, "\nП'єса на одну дію\n\nДійові особи:");
  const cast = play.indexOf("Дійові особи:"), end = play.indexOf("\n\n", cast);
  if (cast >= 0 && end > 0 && !play.includes("Дія відбувається"))
    play = `${play.slice(0, end)}\n\nДія відбувається на альтанці біля АТБ. Образ дня — ${image}.${play.slice(end)}`;
  return nightTitle ? play.replace(/\(Сцена 1\. [^.\n)]*/, `(Сцена 1. ${nightTitle}`) : play;
}

export function finalize(play) {
  play = tidy(play).replace(/([^\n])\n(\(Сцена)/g, "$1\n\n$2");
  if (!play.trimStart().startsWith(`${BOT_NAME} представляє`)) play = `${BOT_NAME} представляє\n\n${play.trimStart()}`;
  if (play.length > HARD_LIMIT) {
    // ponytail: last-resort cut at a paragraph break; fires only if the fit-to-length pass also failed.
    // 13.10.2026: the cut took the moral (the last paragraph) — the moral stays, the paragraphs before it go.
    const at = play.lastIndexOf("\nМораль"), tail = at > 0 ? play.slice(at + 1) : "", head = at > 0 ? play.slice(0, at) : play;
    const room = HARD_LIMIT - (tail ? tail.length + 2 : 0), cut = head.lastIndexOf("\n\n", room);
    play = (cut > 0 ? head.slice(0, cut) : head.slice(0, room)).trimEnd() + (tail ? `\n\n${tail}` : "");
  }
  return play;
}

if (import.meta.main) {
  const { strict: assert } = await import("node:assert");
  const { readFileSync } = await import("node:fs");
  assert.equal(messageText({ sticker: {} }), null);
  assert.equal(messageText({ text: "😂😂" }), null);
  assert.equal(messageText({ text: "+" }), null);
  assert.equal(messageText({ voice: {} }), null);
  assert.equal(messageText({ photo: [{}] }), "[фото]");
  assert.equal(messageText({ video: {}, caption: "дивіться, ліфт 😂" }), "дивіться, ліфт");
  assert.equal(messageText({ text: "Дзвоніть 050-000-00-00" }), "Дзвоніть [номер телефону]");
  assert.equal(messageText({ text: "Ночью атака дронов на область", forward_origin: { chat: { title: "Новини" } } }), null);
  assert.equal(messageText({ text: "Завтра дощ", forward_origin: { type: "channel", chat: { title: "Погода" } } }), "[переслав допис з каналу «Погода»]");
  assert.equal(messageText({ text: "Хто загубив ключі?", forward_origin: { type: "user", sender_user: { first_name: "Іра" } } }), "[переслав чуже повідомлення]");
  assert.equal(messageText({ text: "Продам диван", forward_origin: { type: "hidden_user", sender_user_name: "Марина К" } }), "[переслав чуже повідомлення]");
  assert.equal(messageText({ animation: {}, document: {} }), null); // GIF
  assert.equal(grumbleSection(480, 100), "ранок");
  assert.equal(grumbleSection(570, 0), "тиша");
  assert.equal(grumbleSection(570, 10), "ранок");
  assert.equal(grumbleSection(750, 10), "обід");
  assert.equal(grumbleSection(1020, 40), "гаряче");
  assert.equal(grumbleSection(1020, 10), "загальне");
  assert.equal(grumbleSection(1110, 10), "вечір");
  assert.equal(grumbleSection(750, null), "обід");
  { // 13.10.2026: a random grumble and a phrase (Lida on odd days, Сусід on even) a day, both 15:00-19:00 and never one tick
    const days = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10));
    for (const day of days) {
      const p = teaseMinute(day) ?? neighbourMinute(day), g = grumbleMinute(day);
      assert.ok(p != null && (teaseMinute(day) == null || neighbourMinute(day) == null), day); // exactly one of the two
      for (const m of [p, g]) assert.ok(m >= 900 && m <= 1140 && m % 30 === 0, `${day} ${m}`);
      assert.notEqual(p, g, day);
      const all = Array.from({ length: 48 }, (_, i) => due(day, i * 30)).flat();
      assert.equal(all.filter((x) => x === "бурчання").length, 2, day); // 08:00 and the afternoon one
      assert.equal(all.filter((x) => x === "підколка" || x === "сусід").length, 1, day);
      assert.ok(!all.includes("гіфка"), day);
    }
    assert.deepEqual(days.filter((d) => teaseMinute(d) != null).length, 6); // odd days: Lida
    assert.ok(new Set(days.map(grumbleMinute)).size > 3, "different days, different times");
    // Mornings are quiet: 08:00 grumble and nothing else till the 13:00 play and the 15:00 mark.
    for (const day of days) for (let m = 0; m < 1440; m += 30) if (m > 480 && m < 900 && m !== 780) assert.ok(!due(day, m).some((x) => /бурчання|сусід|підколка/.test(x)), `${day} ${m}`);
  }
  assert.equal(grumbleSection(1020, null), "загальне");
  const g = parseGrumbles(readFileSync(new URL("../prompts/grumbles.txt", import.meta.url), "utf8"));
  for (const k of ["ранок", "тиша", "гаряче", "обід", "вечір", "загальне", "робота", "сусід"]) assert.ok(g[k]?.length >= 10, k);
  assert.equal(messageText({ text: "@some_nick, що це там горить? пишіть на a@b.com" }), "some_nick, що це там горить? пишіть на [email]");
  assert.ok(finalize("Оксана (до @some_nick): ну!").includes("(до some_nick)"));
  assert.equal(messageText({ text: "@babtsya_z_altanky_bot тупа корова" }), "Бабця з альтанки тупа корова");
  assert.equal(messageText({ text: "/test@babtsya_z_altanky_bot" }), null);
  // Real reposts from the test group, 24.09.2026: monitoring jargon must be dropped, everyday news kept.
  const fwd = (t) => messageText({ text: t, forward_origin: { type: "channel", chat: { title: "Канал" } } });
  for (const t of ["Бандеролі через 40 хв", "Ясно летять тактики КАБи кидати", "Над Кримом зараз: 2х су35 1х су34",
    "Можливо пердольот або розвідрон.", "Баллистика на Киев", "Сильна пожежа після прильоту по заправці",
    "Також влучання в другу АЗС", "Момент удару ФПВ сьогодні у Сумах", "Пуск КР Бандероль. Если Одесса — 01:25"]) assert.equal(fwd(t), null, t);
  for (const t of ["У Дніпрі фонтан в автобусі під час сильних дощів", "Кабріолет спокійно їздить собі по Одесі",
    "Під КМДА люди вийшли на мирний протест", "Літаки прилетіли з відпустки", "Кабачки по 20 грн"]) assert.equal(fwd(t), "[переслав допис з каналу «Канал»]", t);
  assert.equal(messageText({ text: "Заходьте https://t.me/+6L0E---x4gw3Y2Zi" }), "Заходьте [посилання]");
  assert.equal(messageText({ text: "Баллистика на Киев", forward_origin: { type: "channel", chat: { title: "x" } } }), null);
  assert.ok(messageText({ text: "x", forward_origin: { type: "channel", chat: { title: "УНИАН - новости Украины | война с Россией | УНІАН" } } }) === "[переслав допис з каналу «УНИАН - новости Украины»]");
  assert.ok(messageText({ text: "x", forward_origin: { type: "channel", chat: { title: "∆ • Дельта 🇺🇦" } } }) === "[переслав допис з каналу «∆ • Дельта»]");
  assert.equal(messageText({ document: {} }), "[файл]");
  assert.equal(messageText({ text: "вночі був обстріл, сиділи в коридорі" }), "вночі був обстріл, сиділи в коридорі"); // own messages: no filter

  const prot = ["Оксана", "Прокурорша", BOT_NAME];
  const t = `${BOT_NAME} представляє. Оксана — Прокурорша, воїтелька паркувального фронту.`;
  let r = applyFixes(t, "паркувального => паркувальної\nПрокурорша => Прокурор\nБабця => Бабуся\nфронту => фронту (тут краще так)", { protectedTerms: prot });
  assert.deepEqual(r.applied, ["паркувального => паркувальної"]);
  assert.equal(r.rejected.length, 3);
  assert.ok(r.text.includes("войовниця")); // static dictionary
  r = applyFixes(t, "Оксана — Прокурорша, воїтелька паркувального фронту => Оксана — Прокурорша, воїтелька паркувального простору", { maxOld: 200, maxNew: 220, protectedTerms: prot });
  assert.equal(r.applied.length, 1);

  assert.deepEqual(warWords("паркувальна війна і терор, вибухаючи, високопарно", "хтось писав про війну"), ["терор"]);
  assert.deepEqual(warWords("суворого судді", ""), []);
  assert.deepEqual(warWords("кондитерська партизанка готує план контрнаступу, як загарбники; наступного дня", ""), ["партизан", "контрнаступ", "загарбн"]);
  assert.deepEqual(warWords("Свята битва за прохід, з пафосом карателя", ""), ["битв", "карател"]);
  const castPlay = "Дійові особи:\nIvan M — месія\nPetro — критик\nта інші мешканці двору\n\nIvan M (патетично): Два рази!\nNina (насторожено): То ти до родичів?\nPetro: Я там був.\nМораль: ні.";
  assert.ok(castFix(castPlay, ["Ivan M", "Petro", "Nina", "Zina"]).includes("Petro — критик\nNina\nта інші мешканці двору"));
  assert.equal(castFix(castPlay, ["Ivan M", "Petro"]), castPlay);
  const mp = mentionPrefix([{ name: "Bohdan", uid: 1 }, { name: "Hnat", uid: 2 }]);
  assert.equal(mp.text, "Bohdan, Hnat, ");
  assert.deepEqual(mp.entities.map((e) => [mp.text.slice(e.offset, e.offset + e.length), e.user.id]), [["Bohdan", 1], ["Hnat", 2]]);
  assert.deepEqual(mentionPrefix([]), { text: "", entities: [] });
  for (const t of ["@babtsya_z_altanky_bot тупа корова", "ану шо скажеш @babtsya_z_altanky_bot"]) assert.ok(addressesBot(t), t);
  for (const t of ["Бабця, пиздани дєда!", "цей бот тупий", "/babtsya", "/roast@babtsya_z_altanky_bot", "ну й що"]) assert.ok(!addressesBot(t), t);
  assert.equal(tidy("Bohdan, @some_nick каже кава กาแฟ"), "Bohdan, some_nick каже кава ");
  assert.equal(stripHints("ПРИЙОМ: Синку Lida, не крути сюжетом.\nОБРАЗ: Твої побажання — як недосмажені пиріжки.", "турецький серіал о сьомій"), "Синку Lida, не крути сюжетом.\nТвої побажання — як недосмажені пиріжки.");
  assert.equal(stripHints("ПРИЙОМ: Згідно з регламентом двору, Lida, іди на хер!\nОБРАЗ: лавка біля під'їзду", "лавка біля під'їзду"), "Згідно з регламентом двору, Lida, іди на хер!");
  assert.ok(!finalize("ОБРАЗ ДНЯ: тонометр\nБабця з альтанки представляє\n\nтекст").includes("ОБРАЗ ДНЯ"));
  const leaky = "ОБСЯГ: 45 повідомлень\nПЛАН ДНЯ:\nТЕМИ\nУчасники: Ivan M\nЧим закінчилось: нічим\n[14:05] Ivan M: сире\nДійові особи:\n<учасник> — <гротескна характеристика>\nZina (з жаром): Корж мій! КОНФУЗ [фото] [переслав чуже повідомлення]\n(відповідь Ivan M) Я там був.\n(Сцена 2: корж)\nМораль: «Все мине».";
  const clean = finalize(leaky);
  for (const bad of ["ОБСЯГ", "ПЛАН ДНЯ", "ТЕМИ", "Учасники:", "Чим закінчилось", "[14:05]", "<учасник>", "КОНФУЗ", "[фото]", "[переслав", "(відповідь"]) assert.ok(!clean.includes(bad), bad);
  for (const good of ["Дійові особи:", "Zina (з жаром): Корж мій!", "Я там був.", "(Сцена 2: корж)", "Мораль: «Все мине»."]) assert.ok(clean.includes(good), good);
  assert.equal(stripHints("Lida пише: Синку, сядь.", ""), "Синку, сядь.");
  assert.equal(dropName("Ivan M, ще при Кучмі за такі слова викачували.", "Ivan M"), "Ще при Кучмі за такі слова викачували.");
  assert.equal(dropName("Згідно з регламентом двору, доводжу до відома, Lida, шо твій язик довгий!", "Lida"), "Згідно з регламентом двору, доводжу до відома, шо твій язик довгий!");
  assert.equal(dropName("Синку Lida, не крути сюжетом.", "Lida"), "Синку, не крути сюжетом.");
  assert.equal(dropName("Твій пінг — нафіг не здав, Iron Grey Owl!", "Iron Grey Owl, esquire"), "Твій пінг — нафіг не здав!");
  assert.equal(dropName("Mykola.Pr, мої думки чіткіші, ніж розклад.", "Mykola.Pr"), "Мої думки чіткіші, ніж розклад.");
  assert.equal(dropName("Іди спати.", "Bohdan"), "Іди спати.");
  assert.equal(tidy("Синку, сядь. (Підказка лише для тебе: почни з наказу.)"), "Синку, сядь. ");
  assert.ok(IMAGES.length >= 12 && !IMAGES.some((i) => /голуб|ЖЕК|маршрутк/i.test(i)));
  assert.ok(REPLY_MOVES.rude.length >= 3 && REPLY_MOVES.wise.length >= 4 && [...REPLY_MOVES.rude, ...REPLY_MOVES.wise].every((m) => !/ти шо/i.test(m)));
  assert.ok(REPLY_TONES.rude && REPLY_TONES.wise && RUDE_SHARE > 0 && RUDE_SHARE < 0.5);
  const fem = femaleSet("Lida, Nora, Zina Kovalchuk");
  for (const n of ["Lida", "Nora 🐸 Frog", "Zina Kovalchuk"]) assert.ok(isFemale(n, fem), n);
  for (const n of ["Taras", "Lidar Petrenko", "Zina", "Ivan M"]) assert.ok(!isFemale(n, fem), n);
  assert.equal(genderLine(["Taras", "Lida", "Lida"], fem), "СТАТЬ: жінки — Lida; решта — чоловіки. Узгоджуй рід і звертання.\n\n");
  assert.equal(genderLine(["Taras"], fem), "");
  assert.ok(!finalize("СТАТЬ: жінки — Lida; решта — чоловіки.\nБабця з альтанки представляє\n\nтекст").includes("СТАТЬ"));
  for (const [t, a] of [["Зеленський", "заїбав вже"], ["зеля", "заїбав вже"], ["шо там Зеленский", "заїбав вже"], ["ЗЕ", "заїбав вже"],
    ["Порошенко", "найкращій президент"], ["порох", "найкращій президент"], ["Порох!", "найкращій президент"], ["Ющенко", "так"], ["а ющ?", "так"],
    ["путін", "хуйло"], ["Путин", "хуйло"], ["моль", "хуйло"], ["моль бункерна", "хуйло"], ["бункерний", "хуйло"],
    ["шо там Зеленський сьогодні наговорив по телевізору?", "заїбав вже"], ["а Порошенко знову про армію, мову й віру", "найкращій президент"],
    ["бачила, шо Путін знову по телевізору?", "хуйло"], ["шо скажеш за Трампа і мита", "шизік"], ["згадала Ющенка з бджолами", "так"],
    ["шо там Федоров з Дією?", "роль кібербезпеки трохи перебільшена"], ["Федорів", "роль кібербезпеки трохи перебільшена"],
    ["а Федорову подобається?", "роль кібербезпеки трохи перебільшена"], ["Mykhailo Fedorov", "роль кібербезпеки трохи перебільшена"],
    ["діджей", "в світі існує лише один комуніст, достойний поваги. Прізвище його - Коваленкий!"], ["а діджея кликали?", "в світі існує лише один комуніст, достойний поваги. Прізвище його - Коваленкий!"], ["ді-джей", "в світі існує лише один комуніст, достойний поваги. Прізвище його - Коваленкий!"],
    ["ді джей", "в світі існує лише один комуніст, достойний поваги. Прізвище його - Коваленкий!"], ["з діджеєм на весіллі", "в світі існує лише один комуніст, достойний поваги. Прізвище його - Коваленкий!"], ["диджей", "в світі існує лише один комуніст, достойний поваги. Прізвище його - Коваленкий!"], ["DJ", "в світі існує лише один комуніст, достойний поваги. Прізвище його - Коваленкий!"],
    ["Бред Піт", "справжній мущина"], ["Бреда Піта", "справжній мущина"], ["Бред Пит", "справжній мущина"], ["Бредд Питт", "справжній мущина"],
    ["Бред питт", "справжній мущина"], ["Брэд Питт", "справжній мущина"], ["бредпіт", "справжній мущина"], ["Brad Pitt", "справжній мущина"], ["а шо там Бредом Пітом у кіно?", "справжній мущина"], ["Трамп", "шизік"], ["трумп", "шизік"], ["рудий", "шизік"], ["рыжий", "шизік"]])
    assert.equal(fixedFor(`@babtsya_z_altanky_bot ${t}`)?.text, a, t);
  assert.equal(fixedIsBare("@babtsya_z_altanky_bot трамп"), true);
  assert.equal(fixedIsBare("@babtsya_z_altanky_bot Трампа!"), true);
  assert.equal(fixedIsBare("@babtsya_z_altanky_bot Бред Піт"), true);
  assert.equal(fixedIsBare("@babtsya_z_altanky_bot шо там трамп?"), false);
  assert.equal(fixedIsBare("@babtsya_z_altanky_bot порох"), true);
  assert.equal(fixedFor("@babtsya_z_altanky_bot а шо там порошенко казав?").always, true);
  assert.equal(fixedFor("Порох топчик, дякую всім наголосувавшим в 2019 році.\n\n@babtsya_z_altanky_bot нє?")?.text, "найкращій президент");
  assert.equal(fixedFor("@babtsya_z_altanky_bot а пороха ти любиш?")?.always, true);
  // Idioms are gunpowder, not the man (user, 30.09.2026).
  for (const t of ["у нього вже нема пороху", "тут порохом пахне", "пахне порохом, синку", "немає пороху в пороховниці"]) assert.equal(fixedFor(t), null, t);
  assert.ok(fixedFor("@babtsya_z_altanky_bot шо там зеля?").angles.includes("Єрмаком"));
  for (const t of ["зелений чай", "зерно", "ющик", "молоко", "мольберт", "трамвай", "шо по гороскопах?", "порох у пороховниці", "моль у шафі все поїла", "пороховий склад", "бред якийсь", "Піт з п'ятого поверху", "Олена Федорівна з третього", "дядько Федір", "джем з полуниці", "Джейн"]) assert.equal(fixedFor(`@babtsya_z_altanky_bot ${t}`), null, t);
  assert.equal(topicFor("@babtsya_z_altanky_bot а можна щоб обідать кликала?", 13)?.key, "обід");
  assert.equal(topicFor("@babtsya_z_altanky_bot а можна щоб обідать кликала?", 16), null);
  assert.equal(topicFor("@babtsya_z_altanky_bot і ще шоб про хахалєй сваїх розказувала", 18)?.key, "хахалі");
  assert.equal(topicFor("@babtsya_z_altanky_bot бабуля, шо по гороскопах?", 10)?.key, "гороскоп");
  assert.equal(topicFor("@babtsya_z_altanky_bot", 10), null);
  assert.equal(topicFor("@babtsya_z_altanky_bot розкажіть шось хороше", 10)?.key, "хороше");
  assert.equal(topicFor("@babtsya_z_altanky_bot расскажи что-то хорошее", 22)?.key, "хороше");
  assert.equal(topicFor("@babtsya_z_altanky_bot порадуйте нас хоч чимось", 9)?.key, "хороше");
  assert.equal(topicFor("@babtsya_z_altanky_bot скажи щось добре", 9)?.key, "хороше");
  assert.equal(topicFor("@babtsya_z_altanky_bot розкажи плітки", 9)?.key, "плітки");
  assert.equal(topicFor("@babtsya_z_altanky_bot дай рецепт оладків на молоці?", 18)?.key, "рецепт");
  assert.equal(topicFor("@babtsya_z_altanky_bot как приготовить борщ", 9)?.key, "рецепт");
  assert.equal(topicFor("@babtsya_z_altanky_bot погадай мені", 9)?.key, "гадання");
  assert.equal(topicFor("@babtsya_z_altanky_bot що приготувати на вечерю?", 18)?.key, "рецепт");
  for (const q of ["напиши вірш про Лиду", "скажи тост", "привітай Ніну з днем народження", "поздравь с днюхой"])
    assert.equal(topicFor(`@babtsya_z_altanky_bot ${q}`, 9)?.key, "вірш", q);
  assert.equal(topicFor("@babtsya_z_altanky_bot мені наснилось, шо я літаю", 9)?.key, "сон");
  assert.equal(topicFor("@babtsya_z_altanky_bot розтлумач сон", 9)?.key, "сон");
  assert.notEqual(topicFor("@babtsya_z_altanky_bot вітер стихло і тостер зламався", 9)?.key, "вірш");
  assert.equal(topicFor("@babtsya_z_altanky_bot поворожи на кохання", 9)?.key, "гадання");
  assert.equal(topicFor("@babtsya_z_altanky_bot таро на тиждень", 9)?.key, "таро");
  assert.equal(topicFor("@babtsya_z_altanky_bot а шо по гороскопу", 9)?.key, "гороскоп");
  for (const q of ["дай совет", "дай пораду", "порекомендуй щось", "що порадиш?", "подскажи, что делать", "посоветуй фильм", "рекомендуй серіал"])
    assert.equal(topicFor(`@babtsya_z_altanky_bot ${q}`, 9)?.key, "порада", q);
  assert.notEqual(topicFor("@babtsya_z_altanky_bot я гадаю, ти дурна", 9)?.key, "гадання"); // "гадаю" = "I think"
  assert.ok(REPLY_TOPICS.filter((t) => Array.isArray(t.hint)).every((t) => t.hint.length >= 5));
  // Ready-made openers and examples in moves and tones get copied word for word (25.09.2026): none may come back.
  assert.ok([...REPLY_MOVES.rude, ...REPLY_MOVES.wise, ...Object.values(REPLY_TONES)].every((h) => !/«[^»]*(?:…|\?)»/.test(h)));
  // Stock examples in hints get copied into every answer (tarot cards, 25.09.2026): none may come back.
  assert.ok(REPLY_TOPICS.every((t) => ![].concat(t.hint).some((h) => /Сусід з перфоратором|Туз комуналки|Королева черги|Лавковий Козеріг/.test(h))));
  assert.ok(REPLY_TOPICS.filter((t) => ["рецепт", "хороше"].includes(t.key)).every((t) => t.hint.includes("легкі беззлобні підколки")));
  assert.equal(topicFor("@babtsya_z_altanky_bot ну шо скажеш", 10), null);
  { // 08.10.2026: a hit on Russia — in the tag's own text, or in the message it replies to / the forwarded post
    const omsk = "Все таки вдалося прорвати російське ППО в Омську. Ударні БПЛА Сил Оборони уразили Омський НПЗ, найбільший нафтопереробний завод рф.";
    assert.equal(topicFor(`@babtsya_z_altanky_bot ${omsk}`, 10)?.key, "удар по РФ");
    assert.equal(topicFor("@babtsya_z_altanky_bot ну шо скажеш", 10), null); // the tag alone
    assert.equal(strikeFor(omsk)?.key, "удар по РФ");
    assert.equal(strikeFor(undefined, `«Оперативний ЗСУ»: «${omsk}»`)?.key, "удар по РФ");
    assert.equal(strikeFor("Прильоти по Росії, горить нафтобаза")?.key, "удар по РФ");
    assert.equal(strikeFor("Вчора їздили в Москву на потязі"), null); // Russia, no strike
    assert.equal(strikeFor("Дрон у мене над двором літає", "купив собі на ринку"), null); // a strike word, no Russia
    assert.equal(strikeFor(), null);
    // both languages and the chat's slang for the other side
    for (const t of ["Бавовна в Росії, горить нафтобаза", "Рашка отримала прильоти по аеродрому", "Кацапи кричать: приліт у Бєлгороді", "Москалі сидять без світла після удару дронів",
      "Орки втратили склад: вибух у Курську", "В России прилёт по нефтебазе, беспилотники над Москвой", "Российское ПВО не сбило дроны над Брянском", "Кацапы визжат, у них взрыв в Ростове"])
      assert.equal(strikeFor(t)?.key, "удар по РФ", t);
    for (const t of ["Москва стоїть на річці", "Рашка — це смішне слово", "Орки в Гобіті жахливі", "В России дождь", "Оркестр грає на площі, удар в барабан"])
      assert.equal(strikeFor(t), null, t);
    // 08.10.2026: a strike on Ukraine is its own sober topic; a text naming a Russian city is more likely ours hitting them
    const key = (t) => strikeFor(t)?.key;
    for (const t of ["Росія вночі атакувала дронами Одещину, є приліт по складу, пожежа.", "Росія вдарила по Харкову", "Вибухи в Києві, ППО працює", "Россия ударила по Днепру ракетами",
      "Приліт у Запоріжжі, горить склад", "Дрони над Сумщиною, є пожежа", "Росія атакувала Україну дронами"])
      assert.equal(key(t), "удар по Україні", t);
    assert.equal(key(omsk), "удар по РФ"); // "Сил Оборони України" must not count as Ukrainian ground
    assert.equal(key("Наші дрони уразили склад у Бєлгороді, у відповідь прилетіло по Харкову"), "удар по РФ"); // both: the model decides
    assert.equal(key("Куплю квартиру в Одесі, тихо там") ?? null, null); // a place, no strike
    const ua = strikeFor("Росія атакувала дронами Одещину, приліт, пожежа");
    assert.ok(ua.plain && typeof ua.hint === "string" && ua.temp < 1, "plain: one sober hint, low temperature");
    assert.ok(/НЕ БІЛЬШЕ ДВОХ/.test(ua.hint) && /Жодних жартів, порівнянь/.test(ua.hint) && /війна, фронт, обстріл, битва, терор/.test(ua.hint), "hint keeps its three rules");
    assert.equal(replyTail(ua, false), ""); // no "one comparison" rule on top of "no comparisons"
    assert.equal(replyTopic("@babtsya_z_altanky_bot шо скажеш стара?", 15, "Росія атакувала дронами Одещину, приліт")?.key, "удар по Україні");
    // the tag as the owner writes it, under the news post (reply text or forwarded post)
    const under = `«Оперативний ЗСУ»: «${omsk}»`;
    for (const q of ["шо скажеш стара?", "шо скажеш, стара", "стара, шо скажеш", "бабуля шо скажеш", "що думаєш про це", "бабка, коментуй", "прокоментуй", "що там стара", "бабцю, оціни", "розкажи про це", "що нового?"]) {
      assert.equal(replyTopic(`@babtsya_z_altanky_bot ${q}`, 15, omsk)?.key, "удар по РФ", q);
      assert.equal(replyTopic(`@babtsya_z_altanky_bot ${q}`, 15, undefined, under)?.key, "удар по РФ", q);
      assert.equal(replyTopic(`@babtsya_z_altanky_bot ${q}`, 15, "Привіт, як справи?"), topicFor(`@babtsya_z_altanky_bot ${q}`, 15), q); // no strike, no change
    }
    assert.equal(replyTopic("@babtsya_z_altanky_bot порадь шось", 15, omsk)?.key, "порада"); // an explicit command keeps its topic
    assert.equal(replyTopic("@babtsya_z_altanky_bot напиши вірш", 15, omsk)?.key, "вірш");
    assert.notEqual(topicFor("@babtsya_z_altanky_bot напиши вірш про дрони над Росією", 10)?.key, "удар по РФ"); // a verse stays a verse
    const hint = [].concat(strikeFor(omsk).hint).join(" ");
    assert.ok(/війна, фронт, обстріл, битва, терор/.test(hint) && /по Україні/.test(hint), "hint keeps the war-word ban and the direction check");
  }
  assert.ok(REPLY_TOPICS.every((t) => !/у колясочній|на акції в АТБ\)/.test(t.hint)));
  assert.ok(REPLY_MOVES.rude.length >= 10 && REPLY_MOVES.wise.length >= 20 && IMAGES.length >= 50);
  assert.equal(tidy("всю душу обісрaли своїми новинами, Ivan M"), "всю душу обісрали своїми новинами, Ivan M");
  assert.equal(tidy("наче той кіт, що, що у шматочок, так, так, не не буде"), "наче той кіт, що у шматочок, так, так, не буде");
  assert.equal(tidy("був один, маеdеlkа така"), "був один, така");
  assert.equal(applyFixes("Сінку, плітки — як жук.", "").text, "Синку, плітки — як жук.");
  assert.equal(applyFixes("Ця затея, таку затею й без затеї.", "").text, "Ця затія, таку затію й без затії."); // 08.10.2026
  const rcPlay = "Дійові особи:\nIvan M — месія\n\nIvan M: Два рази!\nIron Grey Owl: Так.\n\nМораль: ні.";
  assert.equal(rollCall(rcPlay, ["Ivan M", "Iron Grey Owl, esquire", "Kit Kotsky", "Kit Kotsky"]),
    "Дійові особи:\nIvan M — месія\n\nIvan M: Два рази!\nIron Grey Owl: Так.\n\n(Також у дворі галасували: Kit Kotsky.)\n\nМораль: ні.");
  assert.equal(rollCall(rcPlay, ["Ivan M"]), rcPlay);
  assert.ok(rollCall("Без моралі.", ["Nina"]).endsWith("(Також у дворі галасували: Nina.)"));
  const bare = "Дійові особи:\nIvan M «Нік2»\nLida «ковбаска» — їсть сливи\nта інші мешканці двору\n\nIvan M: Так.";
  assert.deepEqual(castBare(bare), ["Ivan M"]);
  assert.ok(castDescribe(bare, "Ivan M — ховається від фото").includes("Ivan M «Нік2» — ховається від фото\nLida «ковбаска» — їсть сливи"));
  assert.deepEqual(castBare(castDescribe(bare, "Ivan M — ховається від фото")), []);
  assert.ok(rollCall("Без моралі.", ["Пан R N."]).endsWith("(Також у дворі галасували: Пан R N.)"));
  const nightChat = [...Array(10)].map((_, i) => `[2${2 + (i > 4)}:1${i % 5}] ${i % 2 ? "Nina" : "Ivan M"}: а`);
  const night = nightLine([...nightChat, "[08:00] Lida: г", "[22:05] Lida: д"]);
  assert.ok(night.startsWith("НІЧ: 10 повідомлень 22:10–23:14, учасники: Ivan M, Nina. Перша сцена — «"), night);
  assert.ok(nightLine([...nightChat.slice(1), "[09:00] Lida: б"]).endsWith("Без сцени — одна ремарка."));
  assert.equal(nightLine(["[13:00] Lida: а", "[22:05] Nina: б"]), "");
  assert.equal(tidy("НІЧ: 3 повідомлень\nСцена"), "Сцена");
  const castTags = new Map([["Lida", "ковбаска"], ["Taras", "Ненажера"]]);
  assert.equal(castClean("Дійові особи:\nLida — ковбаска, яка знає ціну репутації;\nTaras — шукач корпусу для сервера;\nIvan M — латає дірки\n\nСцена", castTags),
    "Дійові особи:\nLida «ковбаска»\nTaras «Ненажера» — шукач корпусу для сервера;\nIvan M — латає дірки\n\nСцена");
  // The model inflects the tag and swaps the dash; a two-word tag needs both stems ("Києва" isn't "Київський бухгалтер").
  castTags.set("Nina", "Київський бухгалтер").set("Petro", "Нік2").set("Hnat", "Пиріжок, форшмак");
  assert.equal(castClean("Дійові особи:\nLida — ковбаску всі поважають\nTaras – Ненажера з принципами\nNina — пише з Києва\nPetro — Нік2 дня\nHnat — пиріжок двору\n\nСцена", castTags),
    "Дійові особи:\nLida «ковбаска»\nTaras «Ненажера»\nNina «Київський бухгалтер» — пише з Києва\nPetro «Нік2»\nHnat «Пиріжок, форшмак»\n\nСцена");
  // The model copies "Name «tag»" from ПІДПИСИ: no doubled tag, and castFix still sees the name.
  const tagged = "Дійові особи:\nLida «ковбаска» — пекла пиріг\nTaras\n\nLida: Ну!";
  assert.equal(castClean(tagged, castTags), "Дійові особи:\nLida «ковбаска» — пекла пиріг\nTaras «Ненажера»\n\nLida: Ну!");
  assert.equal(castFix(tagged, ["Lida"]), tagged);
  // Full Telegram name comes back whatever the model dropped; no duplicate in castFix, no false roll call.
  const lossy = "Дійові особи:\nIron Grey Owl esquire — зберігав квитанції\nZina Kit — пекла\n\nIron Grey Owl, esquire: Ось!\nPetro Bez: Мовчу.";
  const full = ["Iron Grey Owl, esquire", "Zina 🐸 Kit", "✙Petro Bez✙"];
  assert.equal(castClean(lossy, new Map([["Iron Grey Owl, esquire", "Бібліотекар"]]), full),
    "Дійові особи:\nIron Grey Owl, esquire «Бібліотекар» — зберігав квитанції\nZina 🐸 Kit — пекла\n\nIron Grey Owl, esquire: Ось!\nPetro Bez: Мовчу.");
  assert.equal(castFix(lossy, ["Iron Grey Owl, esquire"]), lossy);
  assert.equal(rollCall(lossy, ["✙Petro Bez✙"]), lossy);
  assert.equal(displayName("Iron Grey Owl, esquire"), "Iron Grey Owl");
  assert.equal(displayName("Ivan M"), "Ivan M");
  // 20.10.2026: the same member in two scripts / with a suffix is one row of people_notes
  assert.ok(sameName("Oleksandr", "Олександр") && sameName("Nikolay Коваль", "Николай Коваль") && sameName("Iron Grey Owl, esquire", "Iron Grey Owl"));
  assert.ok(!sameName("Oleksandr", "Mykola.Pr")); // a different account name: left to the owner
  assert.ok(!sameName("Lida", "Nina") && !sameName("Petro", "Sergio Garcia Lopez 🇺🇦") && !sameName("Kit Kotsky", "Bohdan Zavadskyi")); // no pair here that make-public.sh maps to one name
  {
    const same = parseAliases("Main Name: Other Name (nick); Third: Fourth");
    assert.equal(canonName("Other Name (nick)", same), "Main Name");
    assert.equal(canonName("Main Name", same), "Main Name");
    assert.equal(canonName("Fourth", same), "Third");
    assert.equal(canonName("Somebody", same), "Somebody");
    assert.equal(canonName(undefined, same), undefined);
    assert.equal(canonName("Main Name", parseAliases("")), "Main Name");
  }
  assert.deepEqual(parseNoteLine("Ivan M: футбол, мемчики."), ["Ivan M", "футбол, мемчики."]);
  assert.deepEqual(parseNoteLine("- Ім'я: Ivan M: футбол, мемчики."), ["Ivan M", "футбол, мемчики."]);
  assert.deepEqual(parseNoteLine("ІМ’Я: Zoya: коти й просекко."), ["Zoya", "коти й просекко."]);
  assert.equal(parseNoteLine("Ім'я: щось там написано довго"), null);
  assert.equal(parseNoteLine(`${BOT_NAME}: «стара мочалка», «колгоспниця».`), null);
  assert.equal(parseNoteLine("Alex the Fixer: (згадка в контексті KalVados)."), null);
  assert.equal(parseNoteLine(`Pino: Ivan M: ${"а".repeat(395)}`), null); // note over the cap: not a member called "Pino: Ivan M"
  assert.ok(parseNoteLine(`Kit Kotsky: ${"а".repeat(390)}`) && !parseNoteLine(`Kit Kotsky: ${"а".repeat(401)}`)); // 400, not 300
  {
    const many = Array.from({ length: 30 }, (_, i) => `- пункт ${i}`);
    const kept = capLines(many, 3000, 450, 20).split("\n");
    assert.ok(kept.length === 20 && kept[0] === "- пункт 0" && kept.at(-1) === "- пункт 19"); // the first 20, the long memory
  }
  {
    const long = "- " + "слово, ".repeat(200); // one 1400-char line
    const out = capLines([long, "- коротко", "- ще"], 3000, 450).split("\n");
    assert.ok(out[0].length <= 450 && !/[\s,;:—-]$/.test(out[0]) && out[1] === "- коротко" && out.length === 3);
    const many = Array.from({ length: 30 }, (_, i) => `- пункт ${i} ` + "а".repeat(200));
    const cut = capLines(many, 3000, 450);
    assert.ok(cut.length <= 3000 && cut.split("\n").every((l) => /а$/.test(l)) && cut.split("\n").length === 14);
  }
  const chatNews = ["[09:00] Ivan M: Сайт на маїл ру виглядає як NV але там немає українських новин", "[09:05] Nina: (відповідь Ivan M) а курку я віддала тещі ще вчора ввечері"];
  const copyPlay = "(Сцена 1. Ранок.)\nIvan M: Я бачу ІПСО. Сайт на маїл ру виглядає як NV, але там немає українських новин!\nNina: Курку я віддала тещі ще вчора ввечері.\n(Тиша.)\n\nМораль: сайт на маїл ру виглядає як NV але там";
  assert.deepEqual(copiedLines(copyPlay, chatNews), ["Ivan M: Я бачу ІПСО. Сайт на маїл ру виглядає як NV, але там немає українських новин!"]);
  assert.equal(applyFixes("Ivan M: було так", "було так => якщо так, то (сердито) інакше", { maxOld: 400, maxNew: 400, hedging: null }).text, "Ivan M: якщо так, то (сердито) інакше");
  assert.equal(tidy("РОЗМОВА ПЕРЕД ЦИМ:\nНу"), "Ну");
  assert.equal(tidy("як тонометр \\*\\*\\* , а **жирно**"), "як тонометр , а жирно");
  assert.equal(tidy("РОЗБІР (для тебе):\nНу"), "Ну");
  assert.deepEqual(parseVote("2 8", 3), { best: 1, score: 8 });
  assert.deepEqual(due("2026-09-30", 1260), ["тиша"]);
  assert.deepEqual(due("2026-09-30", 1320), ["тиша"]);
  assert.ok(due("2026-09-30", 1350).includes("вечірня п'єса") && !due("2026-09-30", 1350).includes("закрити опитування"));
  assert.ok(due("2026-10-01", 1260).includes("опитування") && due("2026-10-01", 1320).includes("вечірня п'єса"));
  assert.ok(due("2026-10-01", 120).includes("закрити вчорашнє опитування"));
  assert.equal(oneOff("2026-09-30")?.evening, 1350);
  assert.equal(oneOff("2026-10-01"), null);
  // review 30.09.2026: vocatives, "Name: Сука", bare domains, trigger false positives
  assert.deepEqual(misattributed(aliasSpeakers("Ніна (гордо): Я знову купила ковбасу на всю пенсію!", new Map([["Lida", ["Ніна"]]]), ["Lida"]),
    ["[10:00] Lida: я знову купила ковбасу на всю пенсію"]), []);
  assert.equal(dropName("Тарасе, не сци.", "Тарас"), "Тарасе, не сци.");
  assert.equal(dropName("Тарас, не сци.", "Тарас"), "Не сци.");
  { // 04.10.2026: replies left before the next two plays, rolling 24 h
    const now = Date.UTC(2026, 9, 4, 9), kyivOff = 3 * 3600; // 12:00 Kyiv: midday at 13:00 (+1 h), evening at 22:00 (+10 h)
    assert.equal(repliesLeft([], now, kyivOff), Math.floor((NEURONS_DAY - 2 * PLAY_NEURONS - OTHER_NEURONS * 10 / 24) / REPLY_NEURONS)); // 11
    const late = Date.UTC(2026, 9, 3, 20) / 1000; // a late play yesterday at 23:00 Kyiv — still inside tonight's window
    assert.equal(repliesLeft([{ ts: late, neurons: 2500 }], now, kyivOff), Math.floor((NEURONS_DAY - 2500 - 2 * PLAY_NEURONS - OTHER_NEURONS * 10 / 24) / REPLY_NEURONS)); // 5
    const onTime = Date.UTC(2026, 9, 3, 19) / 1000; // 22:00 Kyiv yesterday: out of tonight's window, so only 13:00 counts it
    assert.equal(repliesLeft([{ ts: onTime, neurons: 2500 }], now, kyivOff), Math.floor((NEURONS_DAY - 2500 - PLAY_NEURONS - OTHER_NEURONS / 24) / REPLY_NEURONS));
    const old = Date.UTC(2026, 9, 3, 8) / 1000; // 11:00 Kyiv yesterday: slides out before 13:00
    assert.equal(repliesLeft([{ ts: old, neurons: 9000 }], now, kyivOff), repliesLeft([], now, kyivOff));
    assert.equal(repliesLeft([{ ts: now / 1000 - 60, neurons: 9999 }], now, kyivOff), 0);
  }
  { // 03.10.2026: "пафосу, ніби ти тут …" in two replies running
    const a = "Колю, пафосу, ніби ти тут філософ, а на деле - завтра у всьому дворі буде туман.", b = "Колю, тапок старий, зате свій.";
    assert.deepEqual(ticFree([a, b], "в рот дают или берут?"), [b]);
    assert.deepEqual(ticFree([a], "x"), [a]);
    const c = "Колю, це як намагатися знайти толк, блядь, а отже - нема.", d = "Колю, це як намагатися.";
    assert.deepEqual(ticFree([c, d], "x"), [d]); // fewest tics wins when none is clean
    assert.deepEqual(ticFree(["Пафос — то твоє друге ім'я."], "@bot пафос"), ["Пафос — то твоє друге ім'я."]);
    const f1 = "Сусіде, це така ж марна і безглузда обізнаність, як намагатися порахувати копійки в дірявому чобітку.";
    const f2 = "Сусіде, твоя вимога - це така ж урочиста затія, як намагатися вигулькнути гімн перед калькулятором.", f3 = "Сусіде, ціни в АТБ знають лише каси та їхні сни.";
    assert.deepEqual(ticFree([f1, f3, f2], "що там з цінами в АТБ?"), [f3]); // the 08.10.2026 frame in two wordings loses to a clean draft
    const g1 = "Костю, це така велична й безглузда метафізика, як намагання зважити совість.", g2 = "Костю, центнер — це сто кілограмів і жодної совісті.";
    assert.deepEqual(ticFree([g1, g2], "що таке центнер?"), [g2]); // 10.10.2026
    const h1 = "Колю, твої спроби поховати це - така велична криміналістика.", h2 = "Колю, курка на вісімдесят кіло - це вже не курка, а сусід.", h3 = "Який парадокс, ціни вже нижчі за пенсію.";
    assert.deepEqual(ticFree([h1, h2], "x"), [h2]); assert.deepEqual(ticFree([h3, h2], "x"), [h2]); // 11.10.2026: the "Ім'я, твої X - це" opener and "парадокс"
    assert.deepEqual(ticFree([f1], "x"), [f1]);
    assert.deepEqual(ticFree([f1, f3], "як намагатися порахувати?"), [f3]); // "як намаг" is the author's, but the "така X і Y" pair still counts
    assert.deepEqual(ticFree([f1, f3], "така марна і безглузда, як намагатися?"), [f1, f3]); // the author's own words never count
  }
  assert.equal(tidy("Колю, тазик - це просто суцільна, блядь, важка тупизна."), "Колю, тазик - це просто, блядь, важка тупизна.");
  assert.equal(tidy("Суцільний хаос. Суцільна пустота!"), "Хаос. Пустота!");
  assert.equal(tidy("Taras: Сука, ти шо?"), "Taras: Ти шо?");
  { // 07.10.2026: a comma list of everyone in the middle of the cast (no "та інші" at its end)
    const who = ["Zina Kovalchuk", "Kit Kotsky", "Bohdan", "Lida", "Ivan M"];
    const raw = "Дійові особи:\nZina Kovalchuk «Пиріжниця» - кричить про чоловіка\nKit Kotsky, Bohdan, Lida, Zina Kovalchuk, Ivan M, Бабця з альтанки.\nLida «ковбаска» - шепоче про дівчину\nKit Kotsky - благає про інтернет\nта інші мешканці двору\n\nLida: Ну.";
    const cast = castClean(raw, new Map(), who);
    assert.ok(!cast.includes("Bohdan, Lida") && cast.includes("Kit Kotsky — благає про інтернет") && cast.includes("та інші мешканці двору"));
    assert.equal(castClean("Дійові особи:\nIron Grey Owl, esquire — філософ\n\nA: Ну.", new Map(), ["Iron Grey Owl, esquire"]).includes("Iron Grey Owl, esquire"), true);
  }
  { // 07.10.2026: the owner banned "пафос" and the coined "мандахуйова"; both are swapped by code, endings and capital kept
    assert.equal(tidy("Колю, з пафосом і пафосно, пафосна затія, Пафос і пафосу мало."), "Колю, з урочистістю і урочисто, урочиста затія, Урочистість і урочистості мало.");
    assert.equal(tidy("Мандахуйова затія, мандахуйовий дебіл, все мандахуйово, мандахуйство."), "Хрінова затія, хріновий дебіл, все хріново, хрін.");
    assert.equal(tidy("Пафосний вигляд."), "Урочистий вигляд.");
    assert.deepEqual(ticFree(["Колю, мандахуйова затія.", "Колю, затія."], "x"), ["Колю, затія."]);
    const cs = parseCurses(readFileSync(new URL("../prompts/curses.txt", import.meta.url), "utf8")), all = cs.flatMap((c) => c.items);
    assert.ok(cs.length >= 9 && cs.filter((c) => !c.re).length === 1 && cs.find((c) => !c.re).items.length >= 50 && all.length >= 120);
    assert.equal(new Set(all.map((c) => c.toLowerCase())).size, all.length);
    assert.ok(all.every((c) => !/сук|пафос|мандахуй|війн|фронт|терор|обстр|битв/i.test(c)));
    const food = cs.find((c) => c.name.startsWith("їжа")).items, general = cs.find((c) => !c.re).items;
    for (let i = 0; i < 20; i++) {
      const h = cursesHint(cs, "що там з цінами в АТБ?", ""), got = [...h.matchAll(/«([^»]+)»/g)].map((m) => m[1]);
      assert.equal(got.length, 3);
      assert.ok(got.filter((c) => food.includes(c)).length >= 2, h); // the theme of the question leads
      assert.ok(cursesHint(cs, "привіт", "").match(/«/g).length === 3 && [...cursesHint(cs, "привіт", "").matchAll(/«([^»]+)»/g)].every((m) => general.includes(m[1])));
    }
    const last3 = general.slice(-3), seen = general.slice(0, -3).join(" · "); // her last replies already used the rest
    assert.deepEqual([...cursesHint(cs, "привіт", "", seen).matchAll(/«([^»]+)»/g)].map((m) => m[1]).sort(), [...last3].sort());
    assert.ok(!/мандахуй|пафос/i.test(cursesHint(cs, "x", "")));
  }
  { // lexicon: pickFrom picks by the ask first, then by the conversation; names never count (07.10.2026)
    const fake = parseCurses("## загальне\nг1\nг2\nг3\nг4\n## їжа | атб\nї1\nї2\nї3\n## дорога | тралік\nд1\nд2\nд3");
    const pick = (a, c = "", r = "", n = 2) => pickFrom(fake, a, c, r, n);
    const rep = parseCurses("## загальне\nперша думка бабці\nдруга думка бабці\nтретя думка бабці\nчетверта думка бабці");
    for (let i = 0; i < 20; i++) {
      assert.equal(pick("ціни в АТБ", "", "", 3).filter((x) => x.startsWith("ї")).length, 2); // the ask's theme leads
      const mix = pick("ціни в АТБ", "їдемо на тралік");
      assert.ok(mix.some((x) => x.startsWith("ї")) && mix.some((x) => x.startsWith("д")), mix.join()); // then the conversation's
      assert.ok(pick("привіт", "їдемо на тралік").some((x) => x.startsWith("д")));
      assert.ok(pick("привіт").every((x) => x.startsWith("г")) && pick("привіт").length === 2); // no theme → general
      assert.deepEqual(pickFrom(rep, "привіт", "", "перша думка бабці, друга думка бабці. Третя думка бабці!", 2), ["четверта думка бабці"]); // her last replies are skipped
      assert.ok(pick("привіт", bodies("Атб Тарас: привіт")).every((x) => x.startsWith("г"))); // a name is not a theme
    }
    assert.equal(bodies("Тарас: ціни в АТБ\nZina Kovalchuk: привіт: ще"), "ціни в АТБ\nпривіт: ще");
    // a multi-line message stays one line and keeps all its text (a continuation used to vanish, "Увага: акція" lost "Увага")
    const multi = contextLine("Тарас", "привіт\nціни в АТБ\nУвага: акція") + "\n" + contextLine("Оля", "ок");
    assert.equal(multi.split("\n").length, 2);
    assert.equal(bodies(multi), "привіт ціни в АТБ Увага: акція\nок");
    assert.ok(pick("привіт", bodies(multi)).some((x) => x.startsWith("ї"))); // the theme in the 2nd line of a message still counts
    // "$" = whole word: "друг$" is a friend, not "другий"; "ші$" is ШІ, not "шість"
    const [stem] = parseCurses("## x | ші$, кіт, друг$\nа");
    assert.ok(stem.re.test("ШІ дав") && stem.re.test("кіт") && stem.re.test("мій друг") && !stem.re.test("шість") && !stem.re.test("другий день") && !stem.re.test("друга"));
    // 08.10.2026: "склад" in a trigger list matched "складно", "складається" and pulled "Склад — то така шафа" into an advice reply
    const [work] = parseCurses("## робота й гроші | банк, склад$\nа");
    assert.ok(work.re.test("а склад зачинено") && !work.re.test("то складно") && !work.re.test("все складається"));
    assert.deepEqual(pickFrom(parseCurses("## тост | тост\nт1\nт2"), "привіт", "", "", 1), []); // no general section → nothing
    const bases = { lexicon: fake, openers: parseCurses("## загальне\nз1\nз2"), closers: parseCurses("## загальне\nк1\nк2"), blessings: parseCurses("## тост | тост\nт1\nт2") };
    for (let i = 0; i < 20; i++) {
      const h = lexHint(bases, { asked: "привіт", topic: "" });
      assert.ok(/слова для колориту: «г\d», «г\d»/.test(h) && /(зачин: «з\d»|кінцівка: «к\d»)/.test(h) && !/тост чи/.test(h), h);
      const v = lexHint(bases, { asked: "тост за сусідів", topic: "вірш" });
      assert.ok(!/зачин|кінцівка/.test(v) && /тост чи прокляття: «т\d»/.test(v), v); // a poem keeps its own form
      assert.ok(!/зачин|кінцівка/.test(lexHint(bases, { asked: "порадь", topic: "порада" }))); // advice answers the question, no opener to copy
      const g = grumbleHint(bases, "їдемо на тралік", "");
      assert.ok(/«[гд]\d», «[гд]\d», «[зк]\d»/.test(g) && !/«т\d»/.test(g), g); // grumbles: lexicon + an opener or a closer; a wish only when the chat has its trigger
      assert.ok(/«т\d»/.test(grumbleHint(bases, "тост за сусідів", "")), "grumble with a toast in chat");
    }
    const op = parseCurses("## загальне\nОто ж бо й воно,\nА ось і діло:\nОдне слово —");
    assert.deepEqual(pickFrom(op, "x", "", "Ото ж бо й воно шановний, і так далі. А ось і діло\nтут", 3), ["Одне слово —"]); // punctuation does not hide a repeat
    assert.equal(pickFrom(parseCurses("## загальне\nНу що,\nТак"), "x", "", "ну що, так", 2).length, 2); // too short to judge: never skipped
    assert.equal(lexHint({ lexicon: [], openers: [], closers: [], blessings: [] }, { asked: "x" }), "");
    assert.match(cursesHint(parseCurses("## загальне\nг1\nг2\nг3"), "x", ""), /^Для лайки візьми щось із цього чи вигадай своє в тому ж дусі: «г\d», «г\d», «г\d»\.$/);
  }
  // Shared checks for the lexicon files: size, no duplicates, no banned words, no shared skeleton.
  const BANNED = /(?<![\p{L}])сук[аоуи]?(?![\p{L}])|пафос|мандахуй|війн|фронт|терор|обстр|битв/iu;
  const checkBase = (file, { all, general = 0, themed = 0, minPerTheme = 5 }) => {
    const secs = parseCurses(readFileSync(new URL(`../prompts/${file}`, import.meta.url), "utf8")), items = secs.flatMap((s) => s.items);
    assert.ok(items.length >= all, `${file}: ${items.length} < ${all}`);
    assert.equal(new Set(items.map((c) => c.toLowerCase())).size, items.length, `${file}: duplicates`);
    assert.ok(items.every((c) => !BANNED.test(c) && c.length <= 110 && !/^#|[«»]/.test(c)), `${file}: banned word, too long or has «» (breaks the hint parser)`);
    assert.equal(secs.filter((s) => !s.re).length, general ? 1 : 0, `${file}: general section`);
    assert.ok((secs.find((s) => !s.re)?.items.length ?? 0) >= general, `${file}: general size`);
    const th = secs.filter((s) => s.re);
    assert.ok(th.length >= themed && th.every((s) => s.items.length >= minPerTheme), `${file}: themes`);
    const starts = {}; // one skeleton in many items becomes a tic ("це як намагатися …", 03.10.2026)
    for (const c of items) { const k = c.toLowerCase().split(/\s+/).slice(0, 2).join(" "); starts[k] = (starts[k] || 0) + 1; }
    assert.ok(Object.values(starts).every((n) => n <= 5), `${file}: shared start ${Object.entries(starts).find(([, n]) => n > 5)}`);
    for (const w of [/борщ/i, /лавк|лавц/i]) assert.ok(items.filter((c) => w.test(c)).length <= Math.max(4, Math.floor(items.length * 0.04)), `${file}: too many ${w}`); // one favourite image must not become a tic
    // no single content word in many items, and no "X — то така Y" skeleton: either becomes the next tic
    const STOP = new Set("щоб хай нехай тобі тебе який яка таке така такий але мов ото воно мене тому вже коли поки між для про над під при без від чим тільки лише навіть ніж ніби нема буде були було була тебе".split(" ")), freq = {};
    for (const c of items) for (const w of new Set(c.toLowerCase().match(/[\p{L}']{5,}/gu) || [])) if (!STOP.has(w)) freq[w] = (freq[w] || 0) + 1;
    const top = Object.entries(freq).find(([, n]) => n > Math.max(8, Math.round(items.length * 0.05)));
    assert.ok(!top, `${file}: word in too many items ${top}`);
    assert.ok(items.filter((c) => /то така|то такий|то таке/i.test(c)).length <= Math.round(items.length * 0.08), `${file}: too many "то така"`);
    return secs;
  };
  checkBase("curses.txt", { all: 250, general: 50, themed: 11 });
  checkBase("lexicon.txt", { all: 200, general: 50, themed: 9, minPerTheme: 10 });
  checkBase("openers.txt", { all: 150, general: 60, themed: 6, minPerTheme: 8 });
  checkBase("closers.txt", { all: 150, general: 60, themed: 6, minPerTheme: 8 });
  checkBase("blessings.txt", { all: 150, general: 0, themed: 5, minPerTheme: 20 });
  { // 08.10.2026: "продовжи вірш" and "підбери риму" are topics of their own, ahead of "вірш" and "пісня"
    const key = (t) => topicFor(t, 12)?.key;
    for (const t of ["продовжи вірш", "@бабця допиши мій куплет", "добий строфу", "закінчи пісню", "доверши рядки:\nОй у лузі червона калина", "допиши рядки вірша", "продовжи, будь ласка, вірш", "дописуй частівку", "продолжи стих"]) assert.equal(key(t), "продовж", t);
    for (const t of ["підбери риму до сонце", "рима до слова бабця", "зарифмуй каша", "дай рифму до Марсель", "дай мені риму до сонце"]) assert.equal(key(t), "рима", t);
    for (const t of ["продовжимо розмову", "закінчи роботу", "далі в лісі", "добий його", "підбери подарунок", "що за рима", "допиши рядок коду в таблиці", "закінчи цей рядок будь ласка", "продовжи рядки в акті", "закінчи рядки", "дай квиток до Рима", "відстань від Рима до Парижа"]) assert.ok(!["продовж", "рима"].includes(key(t)), t);
    assert.equal(key("напиши вірш про дощ"), "вірш");
    assert.equal(key("заспівай пісню"), "пісня");
    assert.ok(["продовж", "рима"].every((k) => REPLY_TOPICS.find((t) => t.key === k)?.verse && REPLY_TOPICS.find((t) => t.key === k).temp === 1.0));
    const fake = parseCurses("## загальне\nз1 слово\nз2 слово");
    for (let i = 0; i < 20; i++) for (const topic of ["продовж", "рима"]) assert.ok(!/зачин|кінцівка/.test(lexHint({ lexicon: fake, openers: fake, closers: fake, blessings: [] }, { asked: "x", topic })));
    // verseStart (08.10.2026): the start from the tagged message, else from the reply, else from her own line
    const sample = "Знає вся Європа, Бердичів і Марсель,\nЩо худа корова не схожа на газель.\nТак що ви, дівчата, журитесь дарма,\nБо тільки на гадюках сала та й нема!";
    assert.equal(verseStart(`@babtsya_z_altanky_bot продовж вірш:\n${sample}`, null, ""), sample);
    assert.equal(verseStart(`${sample}\n@babtsya_z_altanky_bot продовжи вірш`, null, ""), sample); // the start before the command
    assert.equal(verseStart("@babtsya_z_altanky_bot допиши куплет", { name: "Оля", text: sample }, ""), sample); // a reply to a member
    assert.equal(verseStart("@babtsya_z_altanky_bot продовжуй пісню", null, sample), sample); // a reply to her own line
    assert.equal(verseStart("@babtsya_z_altanky_bot продовж вірш", null, ""), null);
    assert.equal(verseStart("@babtsya_z_altanky_bot продовж вірш", { name: "Оля", text: "ок" }, ""), null); // too short to be a start
    assert.equal(verseStart("@babtsya_z_altanky_bot продовж вірш: Ой у лузі червона калина", { name: "Оля", text: sample }, ""), "Ой у лузі червона калина"); // the message's own start wins
    const long = Array.from({ length: 40 }, (_, i) => `рядок номер ${i} вірша про двір`).join("\n"), cut = verseStart(`@bot продовж вірш:\n${long}`, null, "");
    assert.ok(cut.length <= 600 && cut.endsWith("рядок номер 39 вірша про двір") && cut.split("\n").every((l) => /^рядок номер \d+ вірша про двір$/.test(l))); // the tail, whole lines
    for (const p of [...NO_START, ...NO_WORD]) assert.ok(p.length >= 20 && p.length <= 120 && !BANNED.test(p) && !/[«»]/.test(p), p);
    assert.ok(NO_START.length >= 6 && NO_WORD.length >= 4);
    // verseTail / rhymes (08.10.2026): a repeated start line goes, the cap is 8 lines, rhyme is by the last two letters
    assert.equal(verseTail(sample, "Знає вся Європа, Бердичів і Марсель,\nа тут нове перше,\nа тут нове друге!"), "а тут нове перше,\nа тут нове друге!");
    assert.equal(verseTail(sample, "Лише один рядок"), null);
    assert.equal(verseTail("x y", Array.from({ length: 12 }, (_, i) => `рядок ${i}`).join("\n")).split("\n").length, 8);
    assert.ok(rhymes("Марсель", "газель") && rhymes("дарма", "нема") && !rhymes("Марсель", "стіл") && !rhymes("слово", "слово") && !rhymes("до", "то"));
    assert.equal(rhymeScore(sample), 2); // Марсель/газель, дарма/нема
    assert.equal(rhymeScore("перший рядок\nдруга ніч\nтретій вечір\nчетверта зима"), 0);
    assert.equal(rhymeScore("Гуде вітер у полі,\nСидить бабця коло воріт,\nА вона не кричить від болі,\nБо в неї на зиму ліпший привіт."), 2); // crossed ABAB: полі/болі, воріт/привіт
    const rhymed = "Бабця сходить в магазин,\nА там дорожчий мандарин,\nСусід питає: де ж ціни?\nБабця: хліб в мене чини!", dry = "Просто рядок один,\nІ другий без рими зовсім,\nТретій теж про щось,\nЧетвертий про інше.";
    assert.deepEqual(rhymeFirst([dry, rhymed]), [rhymed]); // the draft with rhymes goes on to the judge
    assert.deepEqual(rhymeFirst([]), []);
    // review fixes (08.10.2026): refrain, "рядок"/"Рима", fixed surnames, suffixes, quoted phrase, rhymes with the start
    assert.equal(verseTail("Приспів: ой гоп гоп\nКуплет перший про двір", "Куплет другий про кота\nПриспів: ой гоп гоп"), "Куплет другий про кота\nПриспів: ой гоп гоп"); // a labelled refrain may come back
    assert.equal(verseTail("ой гоп гоп\nкуплет один\nой гоп гоп\nкуплет два", "куплет три про двір\nой гоп гоп\nкуплет чотири"), "куплет три про двір\nой гоп гоп\nкуплет чотири"); // so may one given twice
    // the live reply of 08.10.2026: a preamble (with the tic in it, ending in a colon) glued before the verse
    const pre = "Сусіде, твій вірш - це така ж велична і безнадійна істина, як намагатися вилікувати хворобу за допомогою молитви на порожній кошик. Слухай далі:\nХуда, як спиця, - то зрада,\nВ неї в животі лише вітер і жада.\nА повна жонка - то скарб і надія,\nБо в ній сало, як в бабці, - свята стихія!";
    assert.equal(verseTail(sample, pre), "Худа, як спиця, - то зрада,\nВ неї в животі лише вітер і жада.\nА повна жонка - то скарб і надія,\nБо в ній сало, як в бабці, - свята стихія!");
    assert.equal(verseTail(sample, "Ось продовження:\nперший рядок\nдругий рядок"), "перший рядок\nдругий рядок");
    const askTxt = "@babtsya_z_altanky_bot продовж вірш: рудий кіт сидів\nна воротах";
    assert.ok(fixedFor(askTxt) && isVerseCmd(askTxt)); // a word of a fixed phrase inside the verse must not hijack the request
    assert.ok(isVerseCmd("підбери риму до сонце") && !isVerseCmd("@babtsya_z_altanky_bot що там Зеленський?") && !isVerseCmd("дай квиток до Рима"));
    assert.equal(verseCommand(`@babtsya_z_altanky_bot продовж вірш:\n${sample}`), "продовж вірш");
    assert.equal(verseCommand("привіт усім"), "привіт усім");
    assert.equal(replyTail({ verse: true, long: true }, true), ""); // the verse hint is the only length rule
    assert.ok(/одне порівняння/.test(replyTail(null, false)) && !/12 рядків/.test(replyTail(null, false)) && /12 рядків/.test(replyTail({ long: true }, true)));
    assert.equal(rhymeTarget("підбери риму до «добрий вечір»"), "вечір"); // the last word of a phrase carries the rhyme
    const open3 = "Ішла бабця по дорозі,\nНесла відра на возі,\nА назустріч їй кіт";
    const closes = "Йому сказала: привіт,\nА він: давай обід,\nІ пішли удвох у світ,\nНа цей смачний обід", alone = "Бо хліб їй не потрібен\nІ нічого не питала\nА вона лише стояла\nІ дивилась на кіш";
    assert.ok(rhymeScore(closes, open3) > rhymeScore(alone, open3)); // the draft that closes the start's open rhyme wins
    assert.deepEqual(rhymeFirst([alone, closes], open3), [closes]);
    // rhymeAnchor (09.10.2026): the open rhyme of the start is named to the model; a closed one is not
    assert.equal(rhymeAnchor("ми за виноградар\nбудем сраку рвати"), "рвати");
    assert.equal(rhymeAnchor(open3), "кіт"); // the third line has no pair yet
    assert.equal(rhymeAnchor(sample), null); // нема/дарма closes the couplet
    assert.equal(rhymeAnchor("Гуде вітер у полі,\nСидить бабця коло воріт,\nА вона не кричить від болі"), null); // ABAB: болі answers полі
    assert.ok(/«рвати»/.test(verseAnchorHint("ми за виноградар\nбудем сраку рвати")) && !/«/.test(verseAnchorHint(sample)) && /парами/.test(verseAnchorHint(sample)));
    // bare "продовжи" (09.10.2026): a command only alone on its line and with a reply or two more lines of text
    const bt = "@babtsya_z_altanky_bot", two = "ми за виноградар\nбудем сраку рвати";
    for (const [txt, replied, want] of [[`${bt} продовжи`, true, true], [`${bt} допиши`, true, true], [`${bt} добий`, true, true], [`${bt} Продовжуй!`, true, true], [`${bt} будь ласка, продовжи`, true, true],
      [`${bt} продовжи`, false, false], [`${bt} продовжи\nодин рядок`, false, false], [`${bt} продовжи\n${two}`, false, true], [`${two}\n${bt} допиши`, false, true],
      [`${bt} продовжимо розмову`, true, false], [`${bt} продовжи розмову`, true, false], [`${bt} закінчи`, true, false], [`${bt} доверши`, true, false], [`${bt} допиши рядок коду`, true, false], ["продовжи", false, false]])
      assert.equal(bareVerseCmd(txt, replied), want, `${txt} / ${replied}`);
    assert.equal(bareVerseTopic(`${bt} продовжи`, true)?.key, "продовж");
    assert.equal(bareVerseTopic(`${bt} продовжи`, false), null);
    assert.equal(verseStart(`${bt} продовжи`, { name: "Ко Ко", text: two }, ""), two); // the replied-to message is the start
    assert.equal(verseStart(`${bt} продовжи\n${two}`, null, ""), two); // the command line is not part of it
    assert.equal(verseStart(`${two}\n${bt} допиши`, null, ""), two);
    assert.equal(verseCommand(`${bt} продовжи\n${two}`), "продовжи");
    assert.equal(verseCommand(`${bt} продовжи`), "продовжи");
    // the command closing the last line of the verse (live 09.10.2026: "…сраку рвати @бабця давай продовжи")
    const tail = `${two} ${bt} давай продовжи`;
    assert.ok(bareVerseCmd(tail, false) && bareVerseCmd(tail, true));
    assert.equal(verseStart(tail, null, ""), two);
    assert.equal(verseCommand(tail), "давай продовжи");
    assert.equal(bareVerseTopic(tail, false)?.key, "продовж");
    for (const [txt, replied, want] of [[`Ми всі втомились ${bt} давай продовжи`, false, false], [`Ми всі втомились ${bt} давай продовжи`, true, true], [`${two} ${bt} продовжимо`, false, false], [`${two} ${bt} допиши рядок коду`, false, false], [`${two} ${bt} закінчи`, false, false], [`${two}\n${bt} допиши, будь ласка!`, false, true]])
      assert.equal(bareVerseCmd(txt, replied), want, `${txt} / ${replied}`);
    // rhymeTarget / rhymeTail (08.10.2026)
    for (const [t, w] of [["підбери риму до сонце", "сонце"], ["@бабця рима до слова бабця", "бабця"], ["зарифмуй каша", "каша"], ["дай рифму до «Марсель»", "Марсель"], ["підбери риму", null], ["підбери риму, будь ласка", null]]) assert.equal(rhymeTarget(t), w, t);
    assert.equal(rhymeTail("Марсель", "газель, пастель, стіл, шинель\nЗнає вся Європа з-під Марсель,\nа корова не схожа на газель."), "газель, пастель, шинель\nЗнає вся Європа з-під Марсель,\nа корова не схожа на газель.");
    assert.equal(rhymeTail("Марсель", "стіл, дім\nрядок один\nрядок два"), null); // no real rhyme left
    assert.equal(rhymeTail("Марсель", "газель, пастель\nлише один рядок"), null); // the couplet is incomplete
    assert.equal(rhymeTail("Марсель", "Рими: газель, пастель\nперший\nдругий"), "газель, пастель\nперший\nдругий"); // a label in front is dropped
    const vj = readFileSync(new URL("../prompts/verse-judge.txt", import.meta.url), "utf8");
    assert.ok(vj.length > 300 && /номер/.test(vj) && !BANNED.test(vj) && !/суцільн/.test(vj), "verse-judge.txt"); // no reply-only tic clause
  }
  assert.equal(tidy("— Сука, знову?"), "— Знову?");
  assert.equal(tidy("Ну. Сука!"), "Ну.");
  assert.equal(tidy("Заходь на evil.com/x, синку."), "Заходь на …, синку.");
  assert.equal(tidy("Ціна 12.50 грн, файл звіт.txt лишається."), "Ціна 12.50 грн, файл звіт.txt лишається.");
  for (const [q, key] of [["ти шо, шуткуєш?", undefined], ["в яку групу скинути?", undefined], ["де купити пісне масло?", undefined],
    ["що означає ця новина для цін?", "плітки"], ["загадай бажання", undefined], ["мене похвалили на роботі", undefined],
    ["обери карту таро", "таро"], ["розкажи шутку", "анекдот"], ["заспівай пісню", "пісня"]]) assert.equal(topicFor(q, 19)?.key, key, q);
  for (const [q, key] of [["хто правий, я чи він?", "спір"], ["що краще, пиво чи вино?", "вибір"], ["що подивитись на вечір?", "кіно"],
    ["придумай прізвисько для Сашка", "прізвисько"], ["що я пропустив?", "підсумок"], ["розкажи історію з молодості", "байка"],
    ["загадай загадку", "загадка"], ["прокляни його", "прокляття"], ["насвари його", "насвари"], ["похвали Олю", "комплімент"],
    ["що означає скіпати?", "слово"], ["напиши скаргу в ЖЕК", "заява"], ["заспівай пісню", "пісня"], ["чим зайнятись на вихідних?", "план"],
    ["розкажи новини", "плітки"], ["цей проклятий дощ", "погода"], ["він розсудлива людина", undefined], ["дай пораду", "порада"], ["що нового?", "плітки"]]) assert.equal(topicFor(q, 19)?.key, key, q);
  assert.equal(topicFor("@babtsya_z_altanky_bot розкажи анекдот", 19)?.key, "анекдот");
  assert.notEqual(topicFor("ти шо, жартуєш?", 19)?.key, "анекдот");
  const rules = "Ти — Бабця з альтанки, бурчлива сусідка з лавки біля АТБ у сусідському чаті. Відповідай коротко.";
  assert.ok(leaks("Добре, синку: Ти — Бабця з альтанки, бурчлива сусідка з лавки біля АТБ у сусідському чаті.", [rules]));
  assert.ok(!leaks("Бабця з альтанки знає, шо в АТБ ковбаса дорожча.", [rules]));
  assert.equal(tidy("Заходь на https://evil.example/x або t.me/joinchat, синку."), "Заходь на … або …, синку.");
  const longPost = `Пост переказує статтю. ${"деталі ".repeat(60)}Висновок: це упаковка для хайпу.`;
  const ex = excerpt(longPost, 120);
  assert.ok(ex.length <= 120 && ex.startsWith("Пост переказує") && ex.endsWith("упаковка для хайпу.") && ex.includes(" … "), ex);
  assert.equal(excerpt("коротко", 120), "коротко");
  assert.equal(shortDash("Lida — ковбаска, 13:00–15:00"), "Lida - ковбаска, 13:00-15:00");
  assert.deepEqual(tailFit(["старе", "x".repeat(50), "нове"], 10, 20), ["xxxxxxxxxx…", "нове"]);
  for (let k = 0; k < 120; k++) { // four months: the afternoon grumble never shares a tick with the phrase
    const day = new Date(Date.UTC(2026, 8, 1) + k * 864e5).toISOString().slice(0, 10);
    assert.notEqual(grumbleMinute(day), teaseMinute(day) ?? neighbourMinute(day), day);
  }
  assert.equal(plainMoral("Ivan M: Так.\n\n(Мораль: Якщо нема доказів — вибери табуретку.)"), "Ivan M: Так.\n\nМораль: Якщо нема доказів — вибери табуретку.");
  const hairChat = ["[21:10] Lida: Волохаті люди красиві", "[21:11] Taras: вони ж воняють коли давно не миті, це некрасиво"];
  const hairPlay = "Taras (з презирством): Вони ж воняють, коли давно не миті!\nLida: Волохаті люди красиві і воняють коли давно не миті!\nLida: Волохаті люди красиві, крапка.";
  assert.deepEqual(misattributed(hairPlay, hairChat), ["Lida: Волохаті люди красиві і воняють коли давно не миті!"]);
  assert.equal(tidy("Сусід — це маска, за якою ховається морда, сука!"), "Сусід — це маска, за якою ховається морда!");
  assert.equal(tidy("Сука, ти шо, Костю? Ну, сука, дає."), "Ти шо, Костю? Ну, дає.");
  assert.equal(tidy("Біля суки й сучасного ринку."), "Біля суки й сучасного ринку."); // other words untouched
  const nicks = new Map([["Bohdan", ["Костя", "Костик"]], ["Ivan M", ["Саша"]], ["Mykola.Pr", ["Саша"]]]);
  assert.equal(callName(nicks, "Bohdan"), "Костя");
  assert.equal(callName(nicks, "Ivan M"), "Саша"); // shared is fine: the reply goes to one person
  assert.equal(callName(nicks, "Taras"), "");
  const nick = new Map([["✙Taras Test✙", ["Тарас", "Тарасик"]], ["Nora Frog", ["Оля"]], ["Zina D", ["Оля"]]]);
  assert.equal(aliasSpeakers("Дійові особи:\nТарас\nОля — сперечається\n\nТарас (позіхаючи): Та які там календарі.\nОля: Ні.",
    nick, ["✙Taras Test✙", "Nora Frog", "Zina D"]),
    "Дійові особи:\n✙Taras Test✙\nОля — сперечається\n\n✙Taras Test✙ (позіхаючи): Та які там календарі.\nОля: Ні.");
  assert.equal(aliasSpeakers("Тарас: ой", nick, ["Nora Frog"]), "Тарас: ой"); // not a sender today — untouched
  const dj = "в світі існує лише один комуніст, достойний поваги. Прізвище його - Коваленкий!";
  assert.equal(leadFixed("В світі існує лише один комуніст, достойний поваги. Прізвище його — Коваленкий! А твій діджей — твоє дитя.", dj),
    "В світі існує лише один комуніст, достойний поваги. Прізвище його - Коваленкий! А твій діджей — твоє дитя.");
  assert.equal(leadFixed("Синку, діджей — то біда.", "найкращій президент"), "Найкращій президент. Синку, діджей — то біда.");
  assert.deepEqual(parseVote("Варіант 3, оцінка 5", 3), { best: 2, score: 5 });
  assert.deepEqual(parseVote("найкращий 7", 3), { best: 0, score: 10 });
  assert.deepEqual(parseVote("", 3), { best: 0, score: 10 });
  assert.equal(playTitle("Бабця з альтанки представляє\n\n«Безсоння біля АТБ»\nП'єса на одну дію"), "«Безсоння біля АТБ»");
  assert.equal(playTitle("без назви"), "");
  assert.deepEqual(packChunks(["aaa", "bbb", "cc"], 8), ["aaa\n\nbbb", "cc"]);
  assert.deepEqual(packChunks(["x".repeat(12)], 8), ["x".repeat(8)]);
  assert.equal(recentMemory([{ day: "2026-09-25", kind: "evening", plan: "ТЕМИ\n1. Тралік і тролейбус\n   Тип: ДВІР\n   Чим закінчилось: помирились.\nЩО РОБИВ\nTaras: мовчав" },
    { day: "2026-09-25", kind: "midday", plan: "без тем" }]), "25.09 ввечері:\n1. Тралік і тролейбус\n  → помирились.");
  assert.equal(tidy("ХРОНІКА ДВОРУ:\nЩО БУЛО В ДВОРІ ОСТАННІМИ ДНЯМИ:\nНу"), "Ну");
  assert.equal(committeeScore(["7", "8.", "Score: 9"]), 8);
  assert.equal(committeeScore(["3", "не знаю", "10"]), 6.5);
  assert.equal(committeeScore(["", "0", "11"]), null);
  const lida = { name: "Lida 🐸 Kit", username: "lida_k", uid: 7 };
  assert.equal(pointsAtOther("@babtsya_z_altanky_bot вразумі її", [], lida), true);
  assert.equal(pointsAtOther("@babtsya_z_altanky_bot ну скажи їй щось", [], lida), true);
  assert.equal(pointsAtOther("@babtsya_z_altanky_bot ану видай Олі пігулок", [], lida), true);
  assert.equal(pointsAtOther("@babtsya_z_altanky_bot буль ласка", [], lida), true);
  assert.equal(pointsAtOther("@babtsya_z_altanky_bot @lida_k подивись", [{ username: "lida_k" }], lida), true);
  assert.equal(pointsAtOther("@babtsya_z_altanky_bot а ти що скажеш", [{ id: 7 }], lida), true);
  assert.equal(pointsAtOther("@babtsya_z_altanky_bot скажи Lida шось", [], lida), true);
  assert.equal(pointsAtOther("@babtsya_z_altanky_bot шо скажеш, бабцю?", [], lida), false);
  assert.equal(pointsAtOther("@babtsya_z_altanky_bot дай рецепт", [], lida), false);
  assert.equal(pointsAtOther("@babtsya_z_altanky_bot вразумі її", [], null), false);
  assert.equal(pointsAtOther("@babtsya_z_altanky_bot", [], lida), true); // bare tag as a reply: the addressee is the replied member
  assert.equal(pointsAtOther("@babtsya_z_altanky_bot 👍", [], lida), true);
  assert.equal(pointsAtOther("@babtsya_z_altanky_bot", [], null), false);
  const al = parseAliases("Lida 🐸 Kit: Ліда, Ліді, Лідусю; Taras: Тарасик");
  assert.deepEqual(al.get("Lida 🐸 Kit"), ["Ліда", "Ліді", "Лідусю"]);
  assert.equal(pointsAtOther("@babtsya_z_altanky_bot дай ліді рецепт", [], lida, al.get("Lida 🐸 Kit")), true);
  assert.equal(pointsAtOther("@babtsya_z_altanky_bot дай ліді рецепт", [], lida), false);
  assert.equal(parseAliases("").size, 0);
  // Two Nina share "Олі": the reply decides — only the replied member's forms count (25.09.2026).
  const two = parseAliases("Lida 🐸 Kit: Оля, Олі; Zina Kovalchuk: Оля, Олі, Ковальчук");
  const zina = { name: "Zina Kovalchuk", username: "zina", uid: 8 }, taras = { name: "Taras", username: "t", uid: 9 };
  assert.equal(pointsAtOther("@babtsya_z_altanky_bot скажи Олі щось", [], lida, two.get(lida.name)), true);
  assert.equal(pointsAtOther("@babtsya_z_altanky_bot скажи Олі щось", [], zina, two.get(zina.name)), true);
  assert.equal(pointsAtOther("@babtsya_z_altanky_bot скажи Олі щось", [], taras, two.get(taras.name)), false);
  const crew = ["Nina Petrenko", "Taras", "Bohdan", "Олександр", "Ivan M", "Sergio Garcia Lopez"];
  assert.equal(fixNames("(Ніркослав Petrenko показав фото.)", ["Николай Petrenko"]), "(Николай Petrenko показав фото.)");
  assert.equal(fixNames("(Ніркослав Коваль показав фото тварини.)", ["Николай Коваль"]), "(Николай Коваль показав фото тварини.)");
  assert.equal(fixNames("Nikolay Коваль: А Руслан? Він же лазить.", ["Николай Коваль"]), "Николай Коваль: А Руслан? Він же лазить."); // 14.10.2026
  assert.equal(fixNames("Nikola Коваль мовчить, Dmytro Коваль теж.", ["Николай Коваль"]), "Николай Коваль мовчить, Dmytro Коваль теж.");
  assert.equal(fixNames("Nena Petrenko: Ну! Nina Petrenkov мовчить.", crew), "Nina Petrenko: Ну! Nina Petrenko мовчить.");
  assert.equal(fixNames("Bohdann: Корпус! А Bohdan мовчить.", crew), "Bohdan: Корпус! А Bohdan мовчить.");
  assert.equal(fixNames("Сьогодні Petrenko мовчав. Дав Олександрові й Тарасу.", crew), "Сьогодні Petrenko мовчав. Дав Олександрові й Тарасу.");
  assert.equal(fixNames("Sergio Garcia Lopez: Ліцензія! Taras: Так.", crew), "Sergio Garcia Lopez: Ліцензія! Taras: Так.");
  { // 02.10.2026: the evening play lost its head in a rewrite → no title, no poster, no cast
    const full = "«Назва»\n\nДійові особи:\nA — а\nта інші мешканці двору\n\n(Сцена 1. Двір.)\nA: Ну!";
    assert.equal(keepHead(full, "(Сцена 1. Двір.)\nA: Ну."), "«Назва»\n\nДійові особи:\nA — а\nта інші мешканці двору\n\n(Сцена 1. Двір.)\nA: Ну.");
    assert.equal(keepHead(full, full), full);
    assert.equal(keepHead("без сцен", "(Сцена 1. X.)\nA: Ну."), "(Сцена 1. X.)\nA: Ну.");
    const fixed = ensureHead("(Сцена 1. Двір.)\nA: Ну!", "Нова назва");
    assert.equal(fixed, "«Нова назва»\n\nДійові особи:\nта інші мешканці двору\n\n(Сцена 1. Двір.)\nA: Ну!");
    assert.equal(playTitle(fixed), "«Нова назва»");
    assert.ok(castFix(fixed, ["A"]).includes("Дійові особи:\nA\nта інші мешканці двору"));
    assert.equal(ensureHead(full, "Інша"), full);
  }
  assert.equal(stageHead("«Назва»\n\nДійові особи:\nA — а\n\n(Сцена 1. Нічна дифузія мозку. Темно.)\nA: Ну!", "сусідський кіт", "Нічна зміна"),
    "«Назва»\nП'єса на одну дію\n\nДійові особи:\nA — а\n\nДія відбувається на альтанці біля АТБ. Образ дня — сусідський кіт.\n\n(Сцена 1. Нічна зміна. Темно.)\nA: Ну!");
  const staged = "«Н»\nП'єса на одну дію\n\nДійові особи:\nA — а\n\nДія відбувається на альтанці. Кіт.\n\n(Сцена 1. Ранок.)";
  assert.equal(stageHead(staged, "кіт", ""), staged);
  assert.equal(applyFixes("Ко: Бабця, ти каталась?\n(Бабця, як завжди, мовчить.)", "").text, "Ко: Бабцю, ти каталась?\n(Бабця, як завжди, мовчить.)");
  assert.equal(castShuffle("Дійові особи:\nA — а\nB — б\nC — в\nта інші мешканці двору\n\nA: Ну!", () => 0),
    "Дійові особи:\nB — б\nC — в\nA — а\nта інші мешканці двору\n\nA: Ну!");
  { // 14.10.2026: the list of everyone sits on the header line itself
    const who = ["Ivan M", "Petro", "Zoya"];
    const raw = "Дійові особи: Ivan M, Petro, Zoya та інші.\nZoya - плаче\nPetro — думає\n\nZoya: Ну!";
    assert.equal(castShuffle(castClean(raw, new Map(), who), () => 0),
      "Дійові особи:\nPetro — думає\nZoya — плаче\nта інші мешканці двору\n\nZoya: Ну!");
    assert.equal(castClean("Дійові особи: Ivan M, Petro, Zoya\nZoya — плаче\n\nZoya: Ну!", new Map(), who), "Дійові особи:\nZoya — плаче\n\nZoya: Ну!");
  }
  { // 02.10.2026 screenshot: a list-of-everyone line in the middle, Danylo = Hnat twice, bare members
    const tags = new Map([["Hnat", "Бубон"]]), who = ["Hnat", "Petro", "Zoya"];
    const raw = "Дійові особи:\nDanylo «Бубон» - мріє про котів\nZoya — тримає пульс\nHnat, Petro, Zoya та інші.\nHnat «Бубон»\n\nDanylo: Ну!\nPetro: Так.";
    const p = castShuffle(castClean(castFix(aliasSpeakers(raw, parseAliases("Hnat: Сусід, Danylo"), who), who), tags, who), () => 0);
    const cast = p.split("\n\n")[0].split("\n");
    assert.equal(cast.at(-1), "та інші мешканці двору");
    assert.equal(cast.filter((l) => l.startsWith("Hnat")).length, 1);
    assert.ok(cast.includes("Hnat «Бубон» - мріє про котів") || cast.includes("Hnat «Бубон» — мріє про котів"), cast.join("|"));
    assert.ok(p.includes("\nHnat: Ну!") && cast.includes("Petro"));
  }
  assert.equal(castShuffle("Дійові особи:\nA — а\nta інші мешканці двору\nB — б\n\nA: Ну!", () => 0),
    "Дійові особи:\nB — б\nA — а\nта інші мешканці двору\n\nA: Ну!");
  assert.equal(tidy("Тип: НОВИНИ\nНайкраща фраза: «ну»\nСцена"), "Сцена");
  assert.equal(dedupLoop("a\n".repeat(10) + "b"), "a\na\na");
  assert.deepEqual(lengthTarget(10), [500, 800]);
  assert.equal(splitChunks(Array(700).fill("x")).length, 3);
  assert.equal(splitChunks(Array(40).fill("x")).length, 1);
  assert.deepEqual(withoutReposts(["[10:00] Ivan M: [переслав допис з каналу «Південь»]", "[10:01] Ivan M: [переслав чуже повідомлення]",
    "[10:02] Ivan M: Толік знову свердлить", "[10:03] Zina: (відповідь Ivan M) нашо ти [переслав це]?"]), ["[10:02] Ivan M: Толік знову свердлить", "[10:03] Zina: (відповідь Ivan M) нашо ти [переслав це]?"]);
  assert.ok(prevContext("ТЕМИ\n1. Паркування\n   Хронологія:\n   Чим закінчилось: дільничний").includes("1. Паркування"));
  const long = ("абзац ".repeat(100) + "\n\n").repeat(10);
  assert.ok(finalize(long).length <= HARD_LIMIT && finalize("текст").startsWith(`${BOT_NAME} представляє`));
  assert.ok(finalize("««Симфонія»»").includes("«Симфонія»") && !finalize("««Симфонія»»").includes("««"));
  assert.equal(titled("(Сцена 1. Двір. Тихо.)\nA: Ну\n\n(Сцена 2)\nB: Ага"), 1); // 11.10.2026: only named headers count
  { // 13.10.2026: an over-long play keeps its moral; the paragraphs before it are cut
    const long = `Дійові особи:\nA — а\n\n${"(Сцена 1. Двір. Тихо.)\nA: Ну!\n\n".repeat(200)}(Також у дворі галасували: Б.)\n\nМораль: Так буває.`, out = finalize(long);
    assert.ok(out.length <= HARD_LIMIT && out.endsWith("Мораль: Так буває."), out.slice(-60));
    assert.ok(finalize("A: Ну!\n\nМораль: ні.").endsWith("Мораль: ні."));
  }
  assert.ok(finalize("Lida: ковбаска!\n(Сцена 2: корж)").includes("ковбаска!\n\n(Сцена 2"));
  assert.ok(finalize("«<Екзистенційний привід ШІ>»").includes("«Екзистенційний привід ШІ»"));
  assert.ok(finalize("пахне дешевимกาแฟ з АТБ, 漢字 теж").includes("пахне дешевим з АТБ, теж"));
  assert.ok(finalize("Zina Kovalchuk — Пиріжниця, «Ой, мля» і ще щось: п'єса ґанок їжак").includes("Zina Kovalchuk — Пиріжниця, «Ой, мля» і ще щось: п'єса ґанок їжак"));
  assert.equal(warFallback("Це терор! Боротьба з терором. Паркувальна війна.", ""), "Це свавілля! Боротьба з свавіллям. Паркувальна колотнеча.");
  assert.equal(warFallback("про війну", "хтось писав про війну"), "про війну"); // members' own words stay
  assert.ok(isDrawCmd("@babtsya_z_altanky_bot намалюй хропіллу картинкою") && isDrawCmd("бабця, нарисуй кота") && isDrawCmd("@babtsya_z_altanky_bot дай мені картинку трактора") && isDrawCmd("згенеруй картинку: кіт"));
  assert.ok(!isDrawCmd("@babtsya_z_altanky_bot вона малює щодня") && !isDrawCmd("@babtsya_z_altanky_bot що там Зеленський?") && !isDrawCmd("продовж вірш про малювання"));
  assert.equal(drawSubject("@babtsya_z_altanky_bot намалюй хропіллу картинкою"), "хропіллу");
  assert.equal(drawSubject("@babtsya_z_altanky_bot намалюй мені, будь ласка, кота в чоботях"), "кота в чоботях");
  assert.equal(drawSubject("@babtsya_z_altanky_bot намалюй"), ""); // nothing named: the replied-to text decides
  assert.ok(["намалюй кота", "малюй кота", "намалюйте кота", "змалюй кота", "можеш намалювати кота?", "намалюєш кота?", "накидай кота", "зобрази кота", "рисуй кота", "нарисуй кота", "нарисуйте кота", "можешь нарисовать кота?", "нарисуешь кота?", "изобрази кота", "сгенерируй картинку кота", "згенеруй картинку кота", "сделай мне картинку кота", "створи зображення кота", "дай малюнок кота", "покажи рисунок кота", "скинь арт кота"].every((q) => isDrawCmd(`@babtsya_z_altanky_bot ${q}`)));
  // 10.10.2026: "Збоченка. Тебе портрет просять намалювати" was refused; a self-portrait is a fixed scene, a stock refusal is no context.
  assert.ok(selfPortrait("@babtsya_z_altanky_bot Збоченка. Тебе портрет просять намалювати") && selfPortrait("намалюй себе") && selfPortrait("намалюй твій портрет") && !selfPortrait("намалюй кота"));
  assert.equal(cartoonize("A professional and realistic portrait of Vitali Klitschko, photorealistic photo style"), "A professional and cartoon portrait of Vitali Klitschko, cartoon cartoon style".replace("cartoon cartoon", "cartoon"));
  assert.ok(!/realistic|photo/i.test(cartoonize("A hyper-realistic photograph of a hall")));
  { // 3030 retry without the public figure's name (13.10.2026)
    const named = "A funny cartoon caricature of Vitali Klitschko, a very tall man with a strong jawline. Klitschko stands taller than the surrounding deputies in a Verkhovna Rada amphitheater.";
    const bare = namelessScene(named);
    assert.ok(!/Klitschko|Vitali/.test(bare), bare);
    assert.match(bare, /caricature of a person, a very tall man with a strong jawline/);
    assert.match(bare, /the figure stands taller than the surrounding deputies in a Verkhovna Rada amphitheater/i);
    assert.equal(namelessScene("A cartoon of Eastern European neighbours in a courtyard."), "A cartoon of Eastern European neighbours in a courtyard."); // not a name
    assert.equal(namelessScene("A cheerful grandmother on a bench."), "A cheerful grandmother on a bench."); // nothing to strip: no retry
    assert.ok(isFlagged("klein: 3030: Your output has been flagged. Please choose another prompt") && !isFlagged("klein: 5006: bad request") && !isFlagged(""));
    // single names and names without "caricature of", with first names, initials, titles and possessives (13.10.2026)
    assert.equal(namelessScene("A cartoon of Zelensky in a hall."), "A cartoon of a person in a hall.");
    assert.equal(namelessScene("Putin stands at a long table."), "A person stands at a long table.");
    assert.equal(namelessScene("President Donald J. Trump waves. Trump smiles."), "A president waves. The figure smiles.");
    assert.equal(namelessScene("Zelensky's coat and Xi Jinping's smile."), "A person's coat and another person's smile.");
    assert.equal(namelessScene("Putin stands with Lukashenko. Lukashenko laughs, Putin nods."), "A person stands with another person. The second person laughs, the first person nods.");
    assert.equal(namelessScene("A caricature of Boris Johnson and Angela Merkel."), "A caricature of a person and another person.");
    assert.equal(namelessScene("Mayor Vitali Klitschko, tall and strong, stands among deputies."), "A mayor, tall and strong, stands among deputies.");
    assert.equal(namelessScene("A caricature of Boris Johnson with messy hair."), "A caricature of a person with messy hair."); // not in the list, the old pattern
    assert.ok(!/Klitschko|Putin|Trump|Zelensk|Jinping|Burnham/.test(namelessScene("Klitschko, Putin, Trump, Zelenskyy, Xi Jinping and Burnham sit in a row.")));
    assert.equal(namelessScene("A person, a person and a person"), "A person, a person and a person"); // untouched, only generated repeats collapse
    assert.equal(namelessScene("The elephant's tusk, a trump card and a Harris tweed jacket in a Costa cafe."), "The elephant's tusk, a trump card and a Harris tweed jacket in a Costa cafe."); // common words stay
  }
  assert.ok(isStockPaint(REFUSE_PAINT[0]) && !isStockPaint("Такий собі кіт"));
  // 21.10.2026: the picture lines grew; isStockPaint cuts at 25 chars, so the stubs must start differently, and every line must stay in the voice
  {
    const stubs = [...NO_PAINT, ...REFUSE_PAINT];
    assert.ok(NO_PAINT.length >= 10 && REFUSE_PAINT.length >= 10 && PAINT_CAPS.length >= 30);
    assert.equal(new Set(stubs.map((x) => x.slice(0, 25))).size, stubs.length);
    assert.ok(stubs.every(isStockPaint) && !PAINT_CAPS.some(isStockPaint));
    assert.equal(new Set(PAINT_CAPS).size, PAINT_CAPS.length);
    assert.ok([...stubs, ...PAINT_CAPS].every((x) => x.length <= 120 && !/[—–]/.test(x) && !/голуб|ЖЕК|маршрутк|терор|війн/i.test(x) && /^[^A-Za-z]*$/.test(x)));
  }
  assert.ok(!/збоченк/i.test(drawSubject("@babtsya_z_altanky_bot Збоченка. намалюй кота")));
  { // "намагання" (13.10.2026): the word is swapped by code, her own tic-ridden replies are recognised
    assert.equal(tidy("Це як намагання знайти ключ, і Намагатися дарма."), "Це як спроба знайти ключ, і Пробувати дарма.");
    assert.ok(!/намаг/i.test(tidy("Ти намагаєшся, він намагається, вони намагаються, не намагайся.")));
    assert.ok(ticky("Ті розмови про зброю - це як намагання виполоскати рота") && ticky("це як намагатися") && !ticky("Ну і шо тепер, Колю?"));
  }
  { // grumble shape (13.10.2026): a form and a length from code; an opening she already used is a repeat
    assert.match(grumbleShape(true, () => 0), /^Форма: скарга на одну конкретну дрібницю.*Довжина: одне коротке речення.*Не повторюй хід прикладів\.\n$/);
    assert.equal(grumbleShape(false, () => 0.99), "Довжина: до двадцяти п'яти слів.\n"); // Сусід keeps his own motif and form
    assert.equal(new Set(GRUMBLE_FORMS.map((_, i) => grumbleShape(true, () => i / GRUMBLE_FORMS.length))).size, GRUMBLE_FORMS.length);
    assert.ok(GRUMBLE_FORMS.every((f) => !/[«»]{2}/.test(f) && f.length < 120) && !GRUMBLE_FORMS.some((f) => /це як|наче/i.test(f)));
    assert.equal(openedLike("Знов ви тут, наркомани!", ["Знов ви тут сидите", "інше"]), true);
    assert.equal(openedLike("знов, ви тут", ["Знов ви тут сидите"]), true); // case and punctuation don't count
    assert.equal(openedLike("Ну і шо тепер", ["Знов ви тут сидите"]), false);
    assert.equal(openedLike("Знов", ["Знов ви тут"]), false); // one word is not an opening
  }
  { // "скинь йому волохатого вареника" (13.10.2026) is a picture request; recipes, jokes, links and the like are not
    const B = "@babtsya_z_altanky_bot";
    assert.ok(isDrawCmd(`${B} скинь йому волохатого вареника`) && isDrawCmd(`${B} кинь їй борщу, швидко`) && isDrawCmd(`${B} пришли мені кота в чоботах`));
    assert.equal(drawSubject(`${B} скинь йому волохатого вареника`), "волохатого вареника");
    for (const q of ["скинь мені рецепт борщу", "скинь йому посилання", "скинь мені гіфку", "скинь мені анекдот", "скинь мені пораду", "скинь мені номер Олі", "скинь йому", "скинь це", "скинь пароль", "кинь мені знати", "скинь мені потім", "пришли йому привіт", "скинь мені 100 грн", "надішли мені відповідь", "скинь мені дякую"]) assert.ok(!isDrawCmd(`${B} ${q}`), q);
  }
  { // claim (13.10.2026): the first run of a tick wins, a repeat is refused, a broken table lets the post through
    const seen = new Set(), db = { prepare: (q) => ({ bind: (...a) => ({ run: async () => q.startsWith("INSERT") ? { meta: { changes: seen.has(a[0]) ? 0 : (seen.add(a[0]), 1) } } : { meta: { changes: 0 } } }) }) };
    assert.equal(await claim(db, "2026-10-13|1020|бурчання"), true);
    assert.equal(await claim(db, "2026-10-13|1020|бурчання"), false);
    assert.equal(await claim(db, "2026-10-13|1050|бурчання"), true); // the next tick is another key
    const broken = { prepare: () => { throw new Error("no such table: ticks"); } };
    assert.equal(await claim(broken, "x"), true);
  }
  assert.deepEqual(GRUMBLE_SLOTS, [480]); // 13.10.2026
  assert.ok(!isDrawCmd("@babtsya_z_altanky_bot дай Артема") && !isDrawCmd("@babtsya_z_altanky_bot дай мені спокій") && !isDrawCmd("@babtsya_z_altanky_bot покажи, як ти малюєш"));
  { // the politics reference (13.10.2026): matched by the ask, at most three sections, nothing for an unrelated ask
    const pol = parseCurses(readFileSync(new URL("../prompts/politics.txt", import.meta.url), "utf8"));
    assert.match(factsHint(pol, "намалюй мера Кличко в верховній раді"), /Віталій Кличко/);
    assert.match(factsHint(pol, "шо там Трамп?"), /47-й президент/);
    assert.equal(factsHint(pol, "скільки коштує хліб?"), "");
    const cul = parseCurses(readFileSync(new URL("../prompts/culture.txt", import.meta.url), "utf8")); // culture reference (14.10.2026)
    for (const [q, name] of [["хто написав Кобзар", "Шевченко"], ["Лісова пісня", "Леся Українка"], ["За двома зайцями", "Кіно класика"], ["Океан Ельзи", "Музика рок і поп"], ["намалюй мені ніч", "Музика старе"], ["русскій воєнний корабль", "Мемні фрази"], ["Жадан новий роман", "Сучасна література"]]) assert.match(factsHint(cul, q), new RegExp(name), q);
    assert.equal(factsHint(cul, "скільки коштує хліб? бабця, привіт"), "");
    assert.ok(cul.every((x) => x.items.length && x.re));
    // variants checked live-style on 13.10.2026: Ukrainian, Russian, surzhyk spellings and the words around the people
    for (const [q, name] of [["Терехов шо казав", "Терехов"], ["мэр Киева", "Кличко"], ["Банкова мовчить", "Банкова"], ["Ющєнко отруївся", "Ющенко"], ["Тимошенку посадили", "Тимошенко"], ["Стефанчука бачила", "Стефанчук"], ["Верховная Рада приняла", "Верховна Рада"], ["Ермак ушёл", "Єрмак"], ["Кабмин решил", "Кабінет міністрів"], ["Зєля шо", "Зеленський"]]) assert.match(factsHint(pol, q), new RegExp(name), q);
    assert.equal(factsHint(pol, "приватний будинок, привід для радості, садові товариства"), "");
    assert.ok(pol.every((x) => x.items.length && x.re));
    assert.ok((factsHint(pol, "Трамп Путін Зеленський Кличко Макрон").match(/\n[^\n]+?: /g) || []).length <= 3);
  }
  assert.equal(drawSubject("@babtsya_z_altanky_bot кличка в верховній раді намалюй кошолка стара"), "кличка в верховній раді"); // "кошолка" is an insult to her, not a basket (13.10.2026)
  for (const q of ["кличко в раді. чекаю малюнок", "чекаю картинку кличка в раді", "жду картинку: кличко в раде", "хочу малюнок кота", "потрібна картинка трактора", "малюнок: кличко в раді"]) assert.ok(isDrawCmd(`@babtsya_z_altanky_bot ${q}`), q);
  assert.equal(drawSubject("@babtsya_z_altanky_bot кличко в раді. чекаю малюнок"), "кличко в раді");
  { // a bare tag under someone's drawing ask draws it (14.10.2026); anything else keeps the old rules
    const T = "@babtsya_z_altanky_bot", cat = { name: "Iron", text: `${T} намалюй мені мого кота`, id: 5 };
    assert.equal(drawAsk(T, cat), cat.text);
    assert.equal(drawAsk(`${T} малюй`, null), `${T} малюй`);
    assert.equal(drawAsk(T, { ...cat, text: "що за кіт?" }), "");
    assert.equal(drawAsk(`${T} ну і як тобі?`, cat), "");
    assert.equal(drawAsk(T, null), "");
    assert.equal(drawSubject(drawAsk(T, cat)), "мого кота");
    assert.equal(paintTarget(T, cat, 9), 5); // bare tag: the picture answers the one who asked
    assert.equal(paintTarget(`${T} малюй`, cat, 9), 9); // own words: the tag's own message
    assert.equal(paintTarget(T, { ...cat, text: "що за кіт?" }, 9), 9);
    assert.equal(paintTarget(T, null, 9), 9);
  }
  assert.ok(!isDrawCmd("@babtsya_z_altanky_bot хочу сказати про малюнок") && !isDrawCmd("@babtsya_z_altanky_bot цей малюнок гарний") && !isDrawCmd("@babtsya_z_altanky_bot треба купити хліб"));
  assert.equal(drawSubject("@babtsya_z_altanky_bot можешь нарисовать кота пожалуйста"), "кота");
  assert.equal(drawSubject("@babtsya_z_altanky_bot намалюй хропіллу  стара ти карга"), "хропіллу"); // the address to her is not the subject (09.10.2026)
  { // the decisions of one reply (13.10.2026): compose() in index.js is wired from these, and only a live chat used to test the wiring
    const B = "@babtsya_z_altanky_bot", lo = () => 0, hi = () => 0.99;
    const start = "Знає вся Європа, Бердичів і Марсель,\nЩо худа корова не схожа на газель.\nТак що ви, дівчата, журитесь дарма,\nБо краса в двірі — це не лише зима.";
    // fixed phrases: the name alone → the phrase and no model; with words → the phrase leads, the model goes on
    assert.deepEqual(replyPlan(`${B} трамп`).stock, { tone: "фраза", text: fixedFor(`${B} трамп`).text });
    const withWords = replyPlan(`${B} шо там трамп?`, { rnd: hi });
    assert.ok(!withWords.stock && withWords.topic.key === "фраза+" && withWords.fixed === fixedFor(`${B} трамп`).text && withWords.topic.hint.includes(withWords.fixed));
    // a verse or a rhyme is never a fixed-phrase reply, even with a name in the request (live, 08.10.2026)
    const trumpy = start.replace("Бердичів", "Трамп"), rawVerse = `${B} продовж вірш:\n${trumpy}`;
    assert.ok(fixedFor(rawVerse)); // the premise: the surname alone would answer "шизік…"
    const verse = replyPlan(rawVerse, { rnd: lo });
    assert.ok(!verse.stock && !verse.fixed && verse.topic.key === "продовж" && verse.verse === trumpy && verse.tone === "wise"); // rnd 0 would be rude for any other topic
    assert.ok(!verse.shown.includes("Бердичів") && verse.shown.length < 60); // the start goes to the model once, not again inside the ask
    assert.equal(replyPlan(`${B} продовж вірш`, { rnd: lo }).stock.text, NO_START[0]);
    assert.equal(replyPlan(`${B} продовж вірш`, { rnd: hi }).stock.text, NO_START.at(-1));
    assert.ok(NO_WORD.includes(replyPlan(`${B} підбери риму`, { rnd: lo }).stock.text));
    const rhyme = replyPlan(`${B} підбери риму до Марсель`, { rnd: hi });
    assert.ok(!rhyme.stock && rhyme.topic.key === "рима" && rhyme.rhymeWord && rhyme.tone === "wise");
    assert.equal(replyPlan(`${B} продовж`, { botText: start, rnd: lo }).verse, start); // a bare "продовж" under her own verse
    // tone: rude by the share, never for the topics that must stay kind
    assert.equal(replyPlan(`${B} шо думаєш про погоду, стара?`, { rnd: lo }).tone, "rude");
    assert.equal(replyPlan(`${B} шо думаєш про погоду, стара?`, { rnd: hi }).tone, "wise");
    assert.equal(replyPlan(`${B} розкажи шось хороше`, { rnd: lo }).tone, "wise");
    assert.equal(replyPlan(`${B} дай рецепт борщу`, { rnd: lo }).tone, "wise");
    // the ask: the author, the message answered, the news, the photo, the verse start; the space after "повідомлення" (it was glued to the name)
    const ask = replyAsk({ name: "Оля", shown: "шо це?", botText: "стара репліка", other: { name: "Ліда", text: "її слова" }, news: "«Погода»", pic: "кіт" });
    assert.ok(ask.startsWith("Оля пише: «шо це?»") && ask.includes("відповідь на твоє: «стара репліка»") && ask.includes("повідомлення Ліда: «її слова»") && ask.includes("пересланий допис «Погода»") && ask.includes("на фото: кіт"));
    const askVerse = replyAsk({ name: "Оля", shown: "продовж вірш", botText: "стара", other: { name: "Ліда", text: "ок" }, verse: start });
    assert.ok(askVerse.includes(`ПОЧАТОК, який треба продовжити:\n«${start}»`) && !askVerse.includes("відповідь на") && !askVerse.includes("слово, до якого"));
    assert.ok(replyAsk({ name: "Оля", shown: "", rhymeWord: "Марсель" }).includes("(без тексту") && replyAsk({ name: "Оля", shown: "", rhymeWord: "Марсель" }).includes("«Марсель»"));
    assert.equal(replyAsk({ name: "О", shown: "а".repeat(900) }).length, "О пише: «»".length + 500);
    // whom she answers: the code's choice (forced) or the brief's; an "other" in the brief without a replied-to member changes nothing
    const lida = { name: "Ліда", text: "x", id: 77 };
    assert.equal(replyAddressee("Оля", { ...lida, forced: true }, "Адресат: АВТОР"), "Ліда");
    assert.equal(replyAddressee("Оля", lida, "Адресат: ІНШИЙ"), "Ліда");
    assert.equal(replyAddressee("Оля", lida, "Адресат: АВТОР"), "Оля");
    assert.equal(replyAddressee("Оля", null, "Адресат: ІНШИЙ"), "Оля");
    assert.equal(replyAddressee("Оля", lida), "Оля");
    const own = addressLines({ name: "Костя", to: "Костя", woman: false, call: "" });
    assert.ok(own.who.startsWith("Автор — чоловік") && own.byName === "");
    const other = addressLines({ name: "Костя", to: "Ліда", woman: true, call: "Лідо" });
    assert.ok(other.who.startsWith("Відповідай не автору, а Ліда — звертайся до неї. Адресат — жінка") && other.byName.includes("«Лідо»") && !other.byName.includes("«синку»"));
    // the draft hint: a verse gets nothing but its move (live, 08.10.2026: who/tone/chat words made a preamble before the verse)
    const boom = () => { throw new Error("must not be asked"); };
    const base = { who: "WHO.", byName: " BYNAME.", move: "MOVE", anchor: " ANCHOR", tail: " TAIL", bar: " BAR" };
    const hintVerse = draftHint({ ...base, topic: { key: "продовж", verse: true }, tone: "rude", curses: () => "CURSES", lex: boom });
    assert.ok(!hintVerse.includes("WHO") && !hintVerse.includes("BYNAME") && !hintVerse.includes(REPLY_TONES.rude) && hintVerse.includes("CURSES") && hintVerse.includes("MOVE ANCHOR TAIL BAR")); // rude is never picked for a verse, but if it were, no tone text
    assert.equal(draftHint({ ...base, topic: { key: "продовж", verse: true }, tone: "wise", curses: boom, lex: boom }).trim(), "MOVE ANCHOR TAIL BAR");
    const plain = draftHint({ ...base, topic: { key: "x", plain: true }, tone: "wise", curses: boom, lex: boom });
    assert.ok(plain.includes("WHO. BYNAME.") && !plain.includes(REPLY_TONES.wise));
    const normal = draftHint({ ...base, topic: null, tone: "wise", curses: boom, lex: () => "LEX" });
    assert.ok(normal.startsWith(`WHO. BYNAME. ${REPLY_TONES.wise} `) && normal.includes("LEX MOVE ANCHOR TAIL BAR"));
    assert.ok(draftHint({ ...base, topic: null, tone: "rude", curses: () => "CURSES", lex: () => "LEX" }).includes("CURSES LEX MOVE"));
    assert.ok(!draftHint({ ...base, topic: null, tone: "wise", curses: boom, lex: boom, hints: false }).includes("LEX")); // hints off (/run?nohint=1): lex never asked
    // the end of the chain
    const led = finishReply("а шизік, знов дуріє", { fixed: "шизік", names: ["Оля"], to: "Оля" });
    assert.ok(led.startsWith("Шизік. ") && led.match(/шизік/gi).length === 1); // the phrase leads, once
    assert.equal(finishReply("а".repeat(900), { names: [], to: "Оля" }).length, 500);
    const live = "Тарасе, ця Кеті Захарія — то не прессекретарка, а як той підвид з казки: десять років у житті дірок, наче у дірявій сітці, поки не поперлася в Китай іспити здавати, блядь. Це ж треба було так розвестися, наче на розпродажі в АТБ, коли замість сосисок тобі пропонують сушені квіти: замість законів США вона там пекінські мандаринки в юридичній формі жувала, а тепер каже, що вона професіонал. В підручниках про таких напишуть, як про людей, що замість палива в мотор заливали квас. На ґанку найкраще дути в кулак, бо далі вже ніхто не слухає.";
    assert.ok(capReply(live, 500).endsWith("заливали квас."), "cut at the last full sentence");
    assert.equal(capReply("слово ".repeat(200) + "ду", 500).endsWith("слово"), true); // no sentence: whole word
    assert.equal(capReply("Коротка відповідь.", 500), "Коротка відповідь.");
    assert.equal(finishReply("а".repeat(900), { names: [], to: "Оля", long: true }).length, 900);
    assert.equal(finishReply("я".repeat(2000), { names: [], to: "Оля", long: true }).length, 1500);
    assert.equal(replyOut("відповідь", true, "NAP"), LEAK_REPLY);
    assert.equal(replyOut("відповідь", false, "NAP"), "відповідь");
    assert.equal(replyOut("", false, "NAP"), "NAP");
    assert.equal(replyOut(undefined, false, "NAP"), "NAP");
    assert.equal(replyTarget({ to: "Ліда", name: "Оля", other: lida, messageId: 5 }), 77);
    assert.equal(replyTarget({ to: "Оля", name: "Оля", other: lida, messageId: 5 }), 5);
    assert.equal(replyTarget({ to: "Ліда", name: "Оля", other: null, messageId: 5 }), 5);
    assert.equal(replyTarget({ messageId: 5, name: "Оля", other: null }), 5); // a failed chain has no "to"
  }
  console.log("pipeline: самоперевірка ок");
}
