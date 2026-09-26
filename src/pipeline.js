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
const STATIC_FIXES = { воїтелька: "войовниця", голубамими: "голубами", летописка: "літописиця", Сінку: "Синку", сінку: "синку", жалікими: "жалюгідними", аотже: "а отже", Аотже: "А отже" };
// "Бабця, ти сьогодні…" — addressing her needs the vocative (25.09.2026). Only at the start of a line or a reply,
// so a remark "(Бабця, як завжди, мовчить)" keeps the nominative.
const VOCATIVE = /(^|: |— )Бабця(?=, )/gm;

const redact = (t) => REDACTIONS.reduce((s, [re, ph]) => s.replace(re, ph), t);
// "@nick" in the digest would ping that person; the bare nick keeps the meaning without a notification.
const MENTION = /(^|[^\w.@])@([A-Za-z][\w]{3,31})/g;
export const unmention = (t) => t.replace(MENTION, "$1$2");
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

// Grumbles: every 90 min from 08:00 to 18:30 Kyiv (minutes of the day); 08:00 is always a morning one.
// 20:00–08:00 she is silent: the evening has the 21:00 poll and the 22:00 play (user, 25.09.2026).
export const GRUMBLE_SLOTS = [480, 570, 660, 750, 840, 930, 1020, 1110];
export const MIDDAY_QUIET = [13 * 60, 15 * 60]; // after the 13:00 play only the 12:30 lunch call, nothing till 15:00
const HOT_MIN = 30, QUIET_MAX = 2; // ponytail: messages in the last 90 min; tune on the real group

// Сусід gets one phrase a day at a half-hour tick 09:00–19:30 that no regular grumble uses and that isn't in the
// 13:00–15:00 quiet. The tick comes from the date itself, so there's nothing to store and a retried cron can't post it twice.
// ponytail: day number × 7 over 12 ticks — next day jumps ~3.5 h, the pattern repeats every 12 days.
const NEIGHBOUR_TICKS = Array.from({ length: 22 }, (_, i) => 540 + i * 30)
  .filter((m) => !GRUMBLE_SLOTS.includes(m) && !(m >= MIDDAY_QUIET[0] && m < MIDDAY_QUIET[1]));
// One tease (TEASE in wrangler.toml) every second day (odd day numbers, so 25.09.2026 is one) at a half-hour 16:00–23:00 (user, 25.09.2026) — past the evening
// silence on purpose, but not on the 21:00 poll, the 22:00 play or a grumble tick. Same date trick as Сусід.
const TEASE_TICKS = Array.from({ length: 15 }, (_, i) => 960 + i * 30).filter((m) => ![1260, 1320].includes(m) && !GRUMBLE_SLOTS.includes(m));
export const teaseMinute = (day) => {
  const d = Date.parse(day) / 864e5;
  return d % 2 === 1 ? TEASE_TICKS[d % TEASE_TICKS.length] : null;
};
export const neighbourMinute = (day) => NEIGHBOUR_TICKS[((Date.parse(day) / 864e5) * 7) % NEIGHBOUR_TICKS.length];

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
  : minute < 600 ? "ранок"
  : minute >= 720 && minute < 840 ? "обід"
  : minute >= 1110 ? "вечір"
  : "загальне";

// Every answer opened "X, ти шо, з …" and the group noticed ("вона повторюється", 24.09.2026). Code picks the move,
// so variety doesn't depend on the model obeying a "don't repeat yourself" line.
// Tone is picked by code too: one answer in three snaps back, two in three answer what was actually said —
// philosophically, with Poderviansky pathos, no insults (user's ratio, 24.09.2026).
export const RUDE_SHARE = 1 / 3;
export const REPLY_TONES = {
  rude: "Тон грубий: відгавкайся, мат доречний, але спершу відповідь по суті, потім лайка.",
  wise: "Тон філософський: відповідай по суті того, що написав автор, — з пафосом і абсурдом, як мудра бабця на лавці, що бачила все; без образ автора, мат щонайбільше одне слівце для колориту.",
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
    "Відповідай пафосним пророцтвом про двір, АТБ чи людство, що випливає зі сказаного.",
    "Порівняй сказане з рецептом: що туди кинути, скільки варити й чому все одно пригорить.",
    "Відповідай так, ніби пишеш некролог сказаному — урочисто й абсурдно.",
    "Зведи сказане до однієї дрібної побутової істини й подай її як відкриття століття.",
    "Відповідай як мудрий старець із казки, але зі словником бабці з лавки.",
    "Почни з маминої науки й доведи її до абсурду.",
    "Дай пораду, як із цим жити далі, — корисну, але так, що смішно.",
    "Відповідай, ніби це питання до передачі «Здоров'я» чи «Поле чудес», і ведуча — ти.",
    "Знайди у сказаному щось зворушливе й поплач над цим по-бабциному, з пафосом.",
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
  "черга в поліклініку", "пенсійний фонд", "базар на Виноградарі", "тролейбус без світла", "ремонт у сусіда зверху",
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
export function dropName(text, name) {
  const forms = [...new Set([name, name.split(",")[0], name.split(" ")[0]].map((f) => f.trim()).filter((f) => f.length >= 3))];
  for (const f of forms.sort((a, b) => b.length - a.length)) {
    text = text.replace(new RegExp(`^\\s*${esc(f)}\\s*[,:—-]?\\s*`, "i"), "").replace(new RegExp(`\\s+${esc(f)}(?=\\s*[,!?.:—]|$)`, "gi"), "");
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
// Every topic answers the question first: "розклади таро, чи виграє збірна України" got three stock cards about
// the building, not a word about the team (25.09.2026). Hints carry no concrete examples — the model copies them.
export const REPLY_TOPICS = [
  // "дай рецепт оладків на молоці" got a joke about an old TV (25.09.2026): a request gets the real thing, in her voice.
  { key: "рецепт", long: true, re: W("рецепт|як приготув|як зварит|що приготув|шо приготув|що зварит|шо зварит|что приготов|что свари|як спект|як засол|як посол|як зробит|как пригот|как свар|как испеч|как засол|как сдела"),
    hint: "Тема — рецепт: дай СПРАВЖНІЙ робочий рецепт того, що просять: інгредієнти з кількістю й 3–6 коротких кроків, рядками. По-бабциному — з бурчанням на початку й одним жартом наприкінці, але рецепт має бути правильний. Тон м'який, але в стилі Подерв'янського: пафос на рівному місці, суржик, легкі беззлобні підколки («ледащо», «руки-гачки», «недоварена моя»), мату — щонайбільше одне легке слівце, без справжніх образ." },
  // Horoscopes and fortune-telling on request (25.09.2026): code picks the kind each time, so they don't repeat.
  // A verse, a toast, a greeting (for the addressee if it's a reply to someone) — a format, not a one-liner (26.09.2026).
  { key: "вірш", long: true, re: W("вірш|стишок|стишк|стихотвор|стих(?:и|ами)?(?![\\p{L}])|тост(?:а|ом|и)?(?![\\p{L}])|привіта|поздрав|з днем народж|с днем рожд|з днюх|с днюх|частушк|пісеньк|песенк"),
    hint: "Тема — те, що просять: вірш (4–8 рядків у риму), тост (урочисто, з чаркою) чи привітання (побажання, спогад і добре прокляття-побажання наприкінці). Про того, кого чи що просять, пафосно, як на шкільній лінійці, з раптовим суржиком і влучним матом." },
  // Dreams: "мені наснилось…", "розтлумач сон" (26.09.2026).
  { key: "сон", long: true, re: W("сонник|наснил|приснил|снилос|снився|снилас|сниться|розтлумач"),
    hint: "Тема — сонник: розтлумач сон автора за бабциним сонником — кожен символ зі сну: що він означає, і наприкінці пафосне абсурдне пророцтво." },
  { key: "таро", long: true, re: W("таро|tarot"),
    hint: "Тема — таро: розклади три карти з бабциної колоди на те, про що спитали. Карти вигадай щоразу нові, побутові й пов'язані з питанням (без карт із минулих відповідей); для кожної — що вона каже саме про це питання. Наприкінці — пряма відповідь на питання (так / ні / коли) і абсурдна порада. Пафосно, як справжня гадалка." },
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
      "Тема — любовний гороскоп: що зірки кажуть про кохання автора — пафосно й без пошлості.",
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
  // Before "порада" and "плітки" ("порадуйте", "розкажи"): "розкажіть шось хороше" (25.09.2026) — Ukrainian and Russian: хороше/хорошее, приємне/приятное, порадуйте, втіште/утешьте…
  { key: "хороше", re: W("хорош|приємн|приятн|позитив|радіс|радост|порадуй|порадувати|порадовать|втіш|утеш|потіш|тепле|тепл[оеі]го|добре слово|доброе слово|(?:щось|шось|що-небудь|что-то|чтото|что-нибудь|шото) добр"),
    hint: "Тема — щось хороше: розкажи коротку теплу історію з двору чи зі свого життя, або світлу дрібницю, що може потішити, — без політики й війни. Бабця бурчить для порядку, але серце в неї добре: автора не лай, закінчи несподіваним теплим панчлайном. Тон м'який, але в стилі Подерв'янського: пафос на рівному місці, суржик, легкі беззлобні підколки («ледащо», «руки-гачки», «недоварена моя»), мату — щонайбільше одне легке слівце, без справжніх образ." },
  // "тег + совет / порада / порекомендуй…" (25.09.2026): Ukrainian and Russian, a different kind of advice each time.
  // If they asked about something concrete, the advice is about exactly that.
  { key: "порада", re: W("порад|порекоменд|рекоменд|що робити|шо робити|як бути|підкаж|посовіту|совіту|совет|посовет|совєт|посовєт|присовєт|подскаж|что делать|шо делать|как быть|допоможи|помоги"),
    hint: [
      "Тема — порада: життєва порада з бабциного досвіду — корисна, але смішна. Якщо спитали про щось конкретне — саме про це.",
      "Тема — порада з побуту: справжня робоча хитрість (пляма, хліб, сусіди, комуналка — або те, про що спитали), з бурчанням.",
      "Тема — «три правила бабці»: три короткі пункти про те, що спитали (чи про життя взагалі), третій абсурдний.",
      "Тема — порада, як у журналі «Робітниця» 1987 року: пафосно, канцеляритом, про те, що спитали.",
      "Тема — порада-притча: коротка історія з бабциного життя з мораллю наприкінці, що пасує до питання.",
    ] },
  { key: "плітки", re: W("пліт|новин|що нового|шо нового|розкажи|хто там"),
    hint: "Тема — плітки: переказуй «новини двору» загально й вигадано, без імен і реальних фактів про людей." },
  { key: "пророцтво", re: W("що буде|шо буде|завтра|передбач|пророк|майбутн"),
    hint: "Тема — пророцтво: передбач авторові чи двору щось пафосне й абсурдне." },
];
// "@бабця + surname" — fixed answers, word for word as the user set them (24.09.2026); checked before topics and fire
// wherever the name stands in the message. "порох" and "моль" are ordinary words too (gunpowder, moth), so they count
// only when the message is that one word.
const WE = (stems) => new RegExp(`(?<![\\p{L}])(?:${stems})(?![\\p{L}])`, "iu"); // whole words, for short or ambiguous stems
export const FIXED_REPLIES = [
  // angles: what she goes on about when the tag has more than the name — directions, not lines to copy (user, 26.09.2026).
  { re: W("зеленськ|зеленск|зелю|зєл[юяі]|zelensk"), alt: WE("зеля|зелі|зелька|зелик|зе"), text: "заїбав вже",
    angles: "знову не бачив, як навколо крадуть; знову кудись полетів; знову відмазує друзів; грає в теніс з Єрмаком" },
  { re: W("порошенк|poroshenk"), only: ["порох"], text: "найкращій президент", always: true }, // always word for word
  { re: W("ющенк|yushchenk"), alt: WE("ющ|юща|ющу|ющем|ющеві"), text: "так" },
  { re: W("путін|путин|путлер|пуйл|бункерн|putin"), alt: WE("ввп|хуйло"), only: ["моль"], text: "хуйло",
    angles: "знову несе хуйню; знову погрожує всьому світу; сидить у бункері й боїться власної тіні" },
  { re: W("трамп|трумп|trump|рудий|рудого|рудому|рижий|рыжий|рыжего"), text: "шизік",
    angles: "знову дуріє; бомбив Іран; тягне гроші звідусіль; вводить мита на все підряд" },
  { re: W("д[іи][\\s-]?дже[йяюєї]"), alt: WE("dj"), text: "в світі існує лише один комуніст, достойний поваги. Прізвище його - Стукальський!" },
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

// Topic titles and endings of the previous digest, so the secretary recognises continuations.
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
export const warFallback = (play, chat) =>
  WAR_FALLBACK.reduce((s, [re, fn]) => s.replace(re, (m, e) => (chat.toLowerCase().includes(m.toLowerCase()) ? m : fn(m, e))), play);

// The «Дійові особи» block as lines (header first) through fn; no block → the play as is.
const editCast = (play, fn) => {
  const start = play.indexOf("Дійові особи:");
  if (start < 0) return play;
  const end = play.indexOf("\n\n", start), stop = end < 0 ? play.length : end;
  return play.slice(0, start) + fn(play.slice(start, stop).split("\n")).join("\n") + play.slice(stop);
};

// A member who speaks but is missing from «Дійові особи» (Nina, 24.09.2026) gets a neutral line there. Only real
// senders are checked, so a stray "Висновок:" never becomes a character.
export const castFix = (play, names) => editCast(play, (lines) => {
  const cast = new Set(lines.slice(1).map((l) => nameKey(castName(l))));
  const add = names.filter((n) => !cast.has(nameKey(n)) && new RegExp(`^${esc(n)}(?: \\([^)\\n]*\\))?:`, "m").test(play))
    .map((n) => `${n} — голос із натовпу`);
  const others = lines.findIndex((l) => l.startsWith("та інші"));
  return others < 0 ? [...lines, ...add] : [...lines.slice(0, others), ...add, ...lines.slice(others)];
});

// «Дійові особи» line = "Name «tag» — role in today's story": the tag is the member's real one, put there by code;
// the model writes only the role. "Lida — сарделька, яка знає ціну репутації" hurt (24.09.2026): if the role
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
  return editCast(play, (lines) => lines.map((l) => {
    const name = real.get(nameKey(castName(l))), desc = l.match(CAST_LINE)[2];
    if (!name) return l;
    const tag = tags.get(name);
    return name + (tag ? ` «${tag}»` : "") + (desc && !(tag && leansOnTag(desc, tag)) ? ` — ${desc}` : "");
  }));
}

// «Дійові особи» in a new order every time, "та інші мешканці двору" stays last (user, 25.09.2026).
export const castShuffle = (play, rnd = Math.random) => editCast(play, ([head, ...body]) => {
  const rest = body.filter((l) => l.startsWith("та інші")), cast = body.filter((l) => !l.startsWith("та інші"));
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

export function rollCall(play, names) {
  const flat = nameKey(play);
  const missing = [...new Set(names)].filter((n) => !flat.includes(nameKey(n.split(",")[0])));
  if (!missing.length) return play;
  const who = missing.length > 12 ? `${missing.slice(0, 12).join(", ")} та ще ${missing.length - 12}` : missing.join(", ");
  return beforeMoral(play, `(Також у дворі галасували: ${who}.)`);
}

// The reply judge answers "2 8" — best draft and its score 1–10. Garbage picks the first draft and counts as
// good, so a confused judge never costs a second round.
export function parseVote(text, n) {
  const [k, score] = (text.match(/\d+/g) ?? []).map(Number);
  return { best: k >= 1 && k <= n ? k - 1 : 0, score: score ?? 10 };
}

// The model garbles real names: "Ніркослав Нифонов" for "Николай Нифонов" (25.09.2026) — then the roll call
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
const garbled = (w, real, known) => w !== real && !known.has(w) && w[0].toLowerCase() === real[0].toLowerCase()
  && w.length >= real.length / 2 && w.length <= real.length * 2;
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
export function beforeMoral(play, line) {
  const moral = play.lastIndexOf("\nМораль");
  return moral < 0 ? `${play.trimEnd()}\n\n${line}` : `${play.slice(0, moral).trimEnd()}\n\n${line}\n${play.slice(moral)}`;
}

// Replicas the writer copied from the chat instead of writing (25.09.2026: news retold word for word): 6 words in a
// row shared with any chat message. The last replica of a scene may stay verbatim — it's the punchline.
const plainWords = (s) => s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
export function copiedLines(play, chat, n = 6) {
  const seen = new Set();
  for (const m of chat) {
    const w = plainWords(m.replace(/^\[\d\d:\d\d\] [^:\n]+: (?:\(відповідь [^)]*\) )?/, ""));
    for (let i = 0; i + n <= w.length; i++) seen.add(w.slice(i, i + n).join(" "));
  }
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

// Every label the model sees in its input and could echo back: block headers, plan fields, template slots,
// chat markers, reply hints. Whole lines for headers and fields, the marker itself for inline ones.
const SERVICE_LINE = new RegExp(
  "^\\s*(?:(?:ОБРАЗ ДНЯ|ОБСЯГ|НІЧ|ПЛАН ДНЯ|ЧАТ|СТАТЬ|ПІДПИСИ УЧАСНИКІВ|ТЕМИ|ЩО РОБИВ|КОНТЕКСТ ПОПЕРЕДНЬОГО ВИПУСКУ|РОЗМОВА ПЕРЕД ЦИМ|ЩО БУЛО В ДВОРІ[^\\n]*|ХРОНІКА ДВОРУ|РОЗБІР|ХТО Є ХТО|ЧАСТИНА \\d+ з \\d+)(?![\\p{L}]).*" +
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
export const tidy = (text) =>
  SERVICE_INLINE.reduce(
    (t, re) => t.replace(re, ""),
    fixMixed(unmention(text)).replace(/\[(?:номер телефону|номер картки|email|посилання)\]/g, "…").replace(/«{2,}/g, "«").replace(/»{2,}/g, "»")
      .replace(/«<([^<>»\n]*)>»/g, "«$1»") // the template's «<назва>» copied verbatim (24.09.2026)
      .replace(SERVICE_LINE, ""),
  )
    // Letters of other scripts ("дешевимกาแฟ" — Thai for coffee, 24.09.2026) are dropped; only Cyrillic and Latin stay.
    .replace(/(?:(?![\p{Script=Cyrillic}\p{Script=Latin}])\p{L}\p{M}*)+/gu, "").replace(/\\?\*+/g, "").replace(STUTTER, "$1").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n"); // …and markdown stars ("\\*\\*\\*", 26.09.2026)

// She answers only to her @handle. Words («бабця», «бот»…), replies to her and /commands no longer call her (24.09.2026).
export const addressesBot = (text) => /(?<![\w/])@babtsya_z_altanky_bot\b/i.test(text); // not /cmd@babtsya…

// The form's fixed parts come from code, the model skips them (25.09.2026): "П'єса на одну дію", the opening line
// with the image of the day when the model wrote none, and the night scene's title from nightLine.
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
    // ponytail: last-resort cut at a paragraph break drops the ending; fires only if "shorten" also failed.
    const cut = play.lastIndexOf("\n\n", HARD_LIMIT);
    play = cut > 0 ? play.slice(0, cut) : play.slice(0, HARD_LIMIT);
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
  const teases = ["2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30"].map(teaseMinute);
  assert.equal(teases.filter((m) => m != null).length, 3, String(teases));
  assert.equal(teases[0], 1290, String(teases)); // 25.09 at 21:30
  assert.ok(teases.every((m) => m == null || (m >= 960 && m <= 1380 && ![1260, 1320, 1020, 1110].includes(m))), String(teases));
  const neighbourDays = ["2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28"].map(neighbourMinute);
  assert.ok(neighbourDays.every((m) => m >= 540 && m < 1200 && m % 30 === 0 && !GRUMBLE_SLOTS.includes(m) && !(m >= 780 && m < 900)), String(neighbourDays));
  assert.ok(new Set(neighbourDays).size > 1, "different days, different times");
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
  assert.ok(castFix(castPlay, ["Ivan M", "Petro", "Nina", "Zina"]).includes("Petro — критик\nNina — голос із натовпу\nта інші мешканці двору"));
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
  const leaky = "ОБСЯГ: 45 повідомлень\nПЛАН ДНЯ:\nТЕМИ\nУчасники: Ivan M\nЧим закінчилось: нічим\n[14:05] Ivan M: сире\nДійові особи:\n<учасник> — <гротескна характеристика>\nZina (з пафосом): Корж мій! КОНФУЗ [фото] [переслав чуже повідомлення]\n(відповідь Ivan M) Я там був.\n(Сцена 2: корж)\nМораль: «Все мине».";
  const clean = finalize(leaky);
  for (const bad of ["ОБСЯГ", "ПЛАН ДНЯ", "ТЕМИ", "Учасники:", "Чим закінчилось", "[14:05]", "<учасник>", "КОНФУЗ", "[фото]", "[переслав", "(відповідь"]) assert.ok(!clean.includes(bad), bad);
  for (const good of ["Дійові особи:", "Zina (з пафосом): Корж мій!", "Я там був.", "(Сцена 2: корж)", "Мораль: «Все мине»."]) assert.ok(clean.includes(good), good);
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
    ["діджей", "в світі існує лише один комуніст, достойний поваги. Прізвище його - Стукальський!"], ["а діджея кликали?", "в світі існує лише один комуніст, достойний поваги. Прізвище його - Стукальський!"], ["ді-джей", "в світі існує лише один комуніст, достойний поваги. Прізвище його - Стукальський!"],
    ["ді джей", "в світі існує лише один комуніст, достойний поваги. Прізвище його - Стукальський!"], ["з діджеєм на весіллі", "в світі існує лише один комуніст, достойний поваги. Прізвище його - Стукальський!"], ["диджей", "в світі існує лише один комуніст, достойний поваги. Прізвище його - Стукальський!"], ["DJ", "в світі існує лише один комуніст, достойний поваги. Прізвище його - Стукальський!"],
    ["Бред Піт", "справжній мущина"], ["Бреда Піта", "справжній мущина"], ["Бред Пит", "справжній мущина"], ["Бредд Питт", "справжній мущина"],
    ["Бред питт", "справжній мущина"], ["Брэд Питт", "справжній мущина"], ["бредпіт", "справжній мущина"], ["Brad Pitt", "справжній мущина"], ["а шо там Бредом Пітом у кіно?", "справжній мущина"], ["Трамп", "шизік"], ["трумп", "шизік"], ["рудий", "шизік"], ["рыжий", "шизік"]])
    assert.equal(fixedFor(`@babtsya_z_altanky_bot ${t}`)?.text, a, t);
  assert.equal(fixedIsBare("@babtsya_z_altanky_bot трамп"), true);
  assert.equal(fixedIsBare("@babtsya_z_altanky_bot Трампа!"), true);
  assert.equal(fixedIsBare("@babtsya_z_altanky_bot Бред Піт"), true);
  assert.equal(fixedIsBare("@babtsya_z_altanky_bot шо там трамп?"), false);
  assert.equal(fixedIsBare("@babtsya_z_altanky_bot порох"), true);
  assert.equal(fixedFor("@babtsya_z_altanky_bot а шо там порошенко казав?").always, true);
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
  assert.ok(REPLY_TOPICS.every((t) => !/у колясочній|на акції в АТБ\)/.test(t.hint)));
  assert.ok(REPLY_MOVES.rude.length >= 10 && REPLY_MOVES.wise.length >= 20 && IMAGES.length >= 50);
  assert.equal(tidy("всю душу обісрaли своїми новинами, Ivan M"), "всю душу обісрали своїми новинами, Ivan M");
  assert.equal(tidy("наче той кіт, що, що у шматочок, так, так, не не буде"), "наче той кіт, що у шматочок, так, так, не буде");
  assert.equal(tidy("був один, маеdеlkа така"), "був один, така");
  assert.equal(applyFixes("Сінку, плітки — як жук.", "").text, "Синку, плітки — як жук.");
  const rcPlay = "Дійові особи:\nIvan M — месія\n\nIvan M: Два рази!\nIron Grey Owl: Так.\n\nМораль: ні.";
  assert.equal(rollCall(rcPlay, ["Ivan M", "Iron Grey Owl, esquire", "Pino Rhino", "Pino Rhino"]),
    "Дійові особи:\nIvan M — месія\n\nIvan M: Два рази!\nIron Grey Owl: Так.\n\n(Також у дворі галасували: Pino Rhino.)\n\nМораль: ні.");
  assert.equal(rollCall(rcPlay, ["Ivan M"]), rcPlay);
  assert.ok(rollCall("Без моралі.", ["Nina"]).endsWith("(Також у дворі галасували: Nina.)"));
  const nightChat = [...Array(10)].map((_, i) => `[2${2 + (i > 4)}:1${i % 5}] ${i % 2 ? "Nina" : "Ivan M"}: а`);
  const night = nightLine([...nightChat, "[08:00] Lida: г", "[22:05] Lida: д"]);
  assert.ok(night.startsWith("НІЧ: 10 повідомлень 22:10–23:14, учасники: Ivan M, Nina. Перша сцена — «"), night);
  assert.ok(nightLine([...nightChat.slice(1), "[09:00] Lida: б"]).endsWith("Без сцени — одна ремарка."));
  assert.equal(nightLine(["[13:00] Lida: а", "[22:05] Nina: б"]), "");
  assert.equal(tidy("НІЧ: 3 повідомлень\nСцена"), "Сцена");
  const castTags = new Map([["Lida", "ковбаска"], ["Taras", "Ненажера"]]);
  assert.equal(castClean("Дійові особи:\nLida — ковбаска, яка знає ціну репутації;\nTaras — шукач корпусу для сервера;\nIvan M — латає дірки\n\nСцена", castTags),
    "Дійові особи:\nLida «ковбаска»\nTaras «Ненажера» — шукач корпусу для сервера;\nIvan M — латає дірки\n\nСцена");
  // The model inflects the tag and swaps the dash; a two-word tag needs both stems ("Одеси" isn't "Одеський фінмон").
  castTags.set("Nina", "Одеський фінмон").set("Petro", "Нік2").set("Hnat", "Пиріжок, форшмак");
  assert.equal(castClean("Дійові особи:\nLida — ковбаску всі поважають\nTaras – Ненажера з принципами\nNina — пише з Одеси\nPetro — Нік2 дня\nHnat — пиріжок двору\n\nСцена", castTags),
    "Дійові особи:\nLida «ковбаска»\nTaras «Ненажера»\nNina «Одеський фінмон» — пише з Одеси\nPetro «Нік2»\nHnat «Пиріжок, форшмак»\n\nСцена");
  // The model copies "Name «tag»" from ПІДПИСИ: no doubled tag, and castFix still sees the name.
  const tagged = "Дійові особи:\nLida «ковбаска» — пекла пиріг\nTaras\n\nLida: Ну!";
  assert.equal(castClean(tagged, castTags), "Дійові особи:\nLida «ковбаска» — пекла пиріг\nTaras «Ненажера»\n\nLida: Ну!");
  assert.equal(castFix(tagged, ["Lida"]), tagged);
  // Full Telegram name comes back whatever the model dropped; no duplicate in castFix, no false roll call.
  const lossy = "Дійові особи:\nIron Grey Owl esquire — зберігав квитанції\nZina Kit — пекла\n\nIron Grey Owl, esquire: Ось!\nPetro Bez: Мовчу.";
  const full = ["Iron Grey Owl, esquire", "Zina 🐸 Kit", "✙Petro Bez✙"];
  assert.equal(castClean(lossy, new Map([["Iron Grey Owl, esquire", "Архіваріус"]]), full),
    "Дійові особи:\nIron Grey Owl, esquire «Архіваріус» — зберігав квитанції\nZina 🐸 Kit — пекла\n\nIron Grey Owl, esquire: Ось!\nPetro Bez: Мовчу.");
  assert.equal(castFix(lossy, ["Iron Grey Owl, esquire"]), lossy);
  assert.equal(rollCall(lossy, ["✙Petro Bez✙"]), lossy);
  assert.equal(displayName("Iron Grey Owl, esquire"), "Iron Grey Owl");
  assert.equal(displayName("Ivan M"), "Ivan M");
  const chatNews = ["[09:00] Ivan M: Сайт на маїл ру виглядає як NV але там немає українських новин", "[09:05] Nina: (відповідь Ivan M) а курку я віддала тещі ще вчора ввечері"];
  const copyPlay = "(Сцена 1. Ранок.)\nIvan M: Я бачу ІПСО. Сайт на маїл ру виглядає як NV, але там немає українських новин!\nNina: Курку я віддала тещі ще вчора ввечері.\n(Тиша.)\n\nМораль: сайт на маїл ру виглядає як NV але там";
  assert.deepEqual(copiedLines(copyPlay, chatNews), ["Ivan M: Я бачу ІПСО. Сайт на маїл ру виглядає як NV, але там немає українських новин!"]);
  assert.equal(applyFixes("Ivan M: було так", "було так => якщо так, то (сердито) інакше", { maxOld: 400, maxNew: 400, hedging: null }).text, "Ivan M: якщо так, то (сердито) інакше");
  assert.equal(tidy("РОЗМОВА ПЕРЕД ЦИМ:\nНу"), "Ну");
  assert.equal(tidy("як тонометр \\*\\*\\* , а **жирно**"), "як тонометр , а жирно");
  assert.equal(tidy("РОЗБІР (для тебе):\nНу"), "Ну");
  assert.deepEqual(parseVote("2 8", 3), { best: 1, score: 8 });
  assert.deepEqual(parseVote("Варіант 3, оцінка 5", 3), { best: 2, score: 5 });
  assert.deepEqual(parseVote("найкращий 7", 3), { best: 0, score: 10 });
  assert.deepEqual(parseVote("", 3), { best: 0, score: 10 });
  assert.equal(playTitle("Бабця з альтанки представляє\n\n«Безсоння біля АТБ»\nП'єса на одну дію"), "«Безсоння біля АТБ»");
  assert.equal(playTitle("без назви"), "");
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
  assert.equal(fixNames("(Ніркослав Нифонов показав фото тварини.)", ["Николай Нифонов"]), "(Николай Нифонов показав фото тварини.)");
  assert.equal(fixNames("Nena Petrenko: Ну! Nina Petrenkov мовчить.", crew), "Nina Petrenko: Ну! Nina Petrenko мовчить.");
  assert.equal(fixNames("Bohdann: Корпус! А Bohdan мовчить.", crew), "Bohdan: Корпус! А Bohdan мовчить.");
  assert.equal(fixNames("Сьогодні Petrenko мовчав. Дав Олександрові й Тарасу.", crew), "Сьогодні Petrenko мовчав. Дав Олександрові й Тарасу.");
  assert.equal(fixNames("Sergio Garcia Lopez: Ліцензія! Taras: Так.", crew), "Sergio Garcia Lopez: Ліцензія! Taras: Так.");
  assert.equal(stageHead("«Назва»\n\nДійові особи:\nA — а\n\n(Сцена 1. Нічна дифузія мозку. Темно.)\nA: Ну!", "сусідський кіт", "Нічна зміна"),
    "«Назва»\nП'єса на одну дію\n\nДійові особи:\nA — а\n\nДія відбувається на альтанці біля АТБ. Образ дня — сусідський кіт.\n\n(Сцена 1. Нічна зміна. Темно.)\nA: Ну!");
  const staged = "«Н»\nП'єса на одну дію\n\nДійові особи:\nA — а\n\nДія відбувається на альтанці. Кіт.\n\n(Сцена 1. Ранок.)";
  assert.equal(stageHead(staged, "кіт", ""), staged);
  assert.equal(applyFixes("Ко: Бабця, ти каталась?\n(Бабця, як завжди, мовчить.)", "").text, "Ко: Бабцю, ти каталась?\n(Бабця, як завжди, мовчить.)");
  assert.equal(castShuffle("Дійові особи:\nA — а\nB — б\nC — в\nта інші мешканці двору\n\nA: Ну!", () => 0),
    "Дійові особи:\nB — б\nC — в\nA — а\nта інші мешканці двору\n\nA: Ну!");
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
  assert.ok(finalize("Lida: сарделька!\n(Сцена 2: корж)").includes("сарделька!\n\n(Сцена 2"));
  assert.ok(finalize("«<Екзистенційний привід ШІ>»").includes("«Екзистенційний привід ШІ»"));
  assert.ok(finalize("пахне дешевимกาแฟ з АТБ, 漢字 теж").includes("пахне дешевим з АТБ, теж"));
  assert.ok(finalize("Zina Kovalchuk — Пиріжниця, «Ой, мля» і ще щось: п'єса ґанок їжак").includes("Zina Kovalchuk — Пиріжниця, «Ой, мля» і ще щось: п'єса ґанок їжак"));
  assert.equal(warFallback("Це терор! Боротьба з терором. Паркувальна війна.", ""), "Це свавілля! Боротьба з свавіллям. Паркувальна колотнеча.");
  assert.equal(warFallback("про війну", "хтось писав про війну"), "про війну"); // members' own words stay
  console.log("pipeline: самоперевірка ок");
}
