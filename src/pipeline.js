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
const STATIC_FIXES = { воїтелька: "войовниця", голубамими: "голубами", летописка: "літописиця" };

const redact = (t) => REDACTIONS.reduce((s, [re, ph]) => s.replace(re, ph), t);
// "@nick" in the digest would ping that person; the bare nick keeps the meaning without a notification.
const MENTION = /(^|[^\w.@])@([A-Za-z][\w]{3,31})/g;
export const unmention = (t) => t.replace(MENTION, "$1$2");

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

export const lengthTarget = (n) => (n <= 20 ? [600, 900] : n <= 150 ? [1200, 2000] : [2000, 3000]);

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

export function applyFixes(text, reply, { maxOld = 40, maxNew = 60, protectedTerms = [] } = {}) {
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
    if (old.length > maxOld || neu.length > maxNew || SUSPECT_COMMENTARY.test(neu) || touchesProtected) {
      rejected.push(`${old} => ${neu}`);
      continue;
    }
    text = text.replaceAll(old, neu);
    applied.push(`${old} => ${neu}`);
  }
  for (const [old, neu] of Object.entries(STATIC_FIXES)) if (text.includes(old)) text = text.replaceAll(old, neu);
  return { text, applied, rejected };
}

// ponytail: stem-in-chat heuristic — a metaphor slips through on a day a member wrote the same word.
export const warWords = (play, chat) => [...new Set((play.match(WAR_WORDS) || []).map((w) => w.toLowerCase()))].filter((w) => !chat.toLowerCase().includes(w));

// Grumbles: every 90 min from 08:00 to 21:30 Kyiv (minutes of the day); 08:00 is always a morning one.
export const GRUMBLE_SLOTS = [480, 570, 660, 750, 840, 930, 1020, 1110, 1200, 1290];
const HOT_MIN = 30, QUIET_MAX = 2; // ponytail: messages in the last 90 min; tune on the real group

// Сусід gets one phrase a day at a half-hour tick 09:00–21:30 that no regular grumble uses. The tick comes from
// the date itself, so there's nothing to store and a retried cron can't post it twice.
// ponytail: day number × 7 over 18 ticks — next day jumps 3.5 h, the pattern repeats every 18 days.
const NEIGHBOUR_TICKS = Array.from({ length: 26 }, (_, i) => 540 + i * 30).filter((m) => !GRUMBLE_SLOTS.includes(m));
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
  : minute >= 1140 ? "вечір"
  : "загальне";

// Every answer opened "X, ти шо, з …" and the group noticed ("вона повторюється", 24.09.2026). Code picks the move,
// so variety doesn't depend on the model obeying a "don't repeat yourself" line.
// Tone is picked by code too: one answer in three snaps back, two in three answer what was actually said —
// philosophically, with Poderviansky pathos, no insults (user's ratio, 24.09.2026).
export const RUDE_SHARE = 1 / 3;
export const REPLY_TONES = {
  rude: "Тон грубий: відгавкайся, мат доречний.",
  wise: "Тон філософський: відповідай по суті того, що написав автор, — з пафосом і абсурдом, як мудра бабця на лавці, що бачила все; без образ автора, мат щонайбільше одне слівце для колориту.",
};
export const REPLY_MOVES = {
  rude: [
    "Почни канцеляритом: «Згідно з регламентом двору…», «Доводжу до відома…» — і зірвись на лайку.",
    "Почни з наказу чи поради: «Іди…», «Сядь…», «Запиши собі…».",
    "Почни з вигуку чи матюка, потім несподівано мудра фраза.",
    "Відповідай одним гострим порівнянням автора з чимось побутовим — без вступу.",
    "Відповідай погрозою в дусі бабці: що вона зробить, якщо автор не вгамується.",
    "Висміюй сказане так, ніби це оголошення на дошці біля під'їзду.",
    "Відповідай, як касирка АТБ наприкінці зміни: коротко, зло й по ділу.",
    "Почни з «Та шоб тебе…» і закінчи несподіваним побажанням.",
    "Прикинься, що доповідаєш дільничному про автора, — сухо й з лайкою.",
    "Відповідай риторичним питанням, яке саме по собі вже образа.",
  ],
  wise: [
    "Почни з філософського узагальнення про життя, двір чи людство.",
    "Почни зі спогаду бабці: «У вісімдесят п'ятому…» — і виведи з нього мораль про те, що написав автор.",
    "Почни з «Синку» (якщо автор чоловік) чи «Доню» (якщо жінка), як бабця, яка зараз прочитає лекцію про суть сказаного.",
    "Відповідай вигаданою народною мудрістю чи приказкою, що несподівано пасує до сказаного.",
    "Зроби вигляд, що не почула, і відповідай про щось своє, бабцине, — але так, щоб це виявилось глибоким коментарем до сказаного.",
    "Відповідай пафосним пророцтвом про двір, АТБ чи людство, що випливає зі сказаного.",
    "Порівняй сказане з рецептом: що туди кинути, скільки варити й чому все одно пригорить.",
    "Відповідай так, ніби пишеш некролог сказаному — урочисто й абсурдно.",
    "Зведи сказане до однієї дрібної побутової істини й подай її як відкриття століття.",
    "Відповідай як мудрий старець із казки, але зі словником бабці з лавки.",
    "Почни з «Колись мені мама казала…» і доведи до абсурду.",
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
  "кабачки й консервація на зиму", "Нова пошта й загублена посилка", "турецький серіал о сьомій", "акція в АТБ на ковбасу",
  "дача й колорадські жуки", "ліфт, що застряг між поверхами", "лічильник за воду", "сусідський кіт", "лавка біля під'їзду",
  "батареї, які не гріють", "шлюб у РАЦСі в дев'яностих", "тиск і тонометр", "бабусин сервант із кришталем",
  "килим на стіні", "олів'є на Новий рік", "трилітрова банка з огірками", "радіоточка на кухні", "черга за хлібом",
  "квитанція за газ", "дзеркало в передпокої", "тапки біля дверей", "гречка про запас", "чайний гриб у банці",
  "прання в тазику", "кросворд у газеті", "лото на дачі", "бабусина скриня", "сусідка з собачкою",
  "шуба в нафталіні", "пляшка кефіру з зеленою кришкою", "табуретка на кухні", "городня лопата", "курси валют на базарі",
  "весілля в їдальні", "ламповий телевізор", "стара «Волга» в гаражі", "похід у баню", "мішок картоплі на балконі",
  "відривний календар", "пральна машина «Малютка»", "рецепт медовика", "дідова вудка", "розсада на підвіконні",
  "черга в собес", "тролейбусний квиток", "аптечка з зеленкою", "сусідський перфоратор", "молочна кухня",
];

// The model echoed its hints into the chat ("ПРИЙОМ: Синку Lida…", "ОБРАЗ: лавка біля під'їзду", 24.09.2026):
// labels are cut, and a line that only repeats the image goes.
const HINT_LABEL = /^\s*(?:ПРИЙОМ|ОБРАЗ(?: ДНЯ)?|ОБСЯГ|ПІДКАЗКА|[^\n:«»]{1,40} пише)\s*:\s*/iu;
export const stripHints = (text, image = "") =>
  text.split("\n").map((l) => l.replace(HINT_LABEL, ""))
    .filter((l) => l.trim() && l.trim().replace(/[.!]$/, "").toLowerCase() !== image.toLowerCase()).join("\n").trim();

// The answer is a reply, so naming the author is noise ("Ivan M, ще при Кучмі…", 24.09.2026). Full name, the part
// before a comma ("Iron Grey Owl") and the first word are cut wherever they stand, then punctuation is mended.
export function dropName(text, name) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
const W = (stems) => new RegExp(`(?<![\\p{L}])(?:${stems})`, "iu");
export const REPLY_TOPICS = [
  { key: "обід", from: 12, to: 14, re: W("обід|обіда|пообіда|їсти|жерти|пиріж|борщ|вареник|котлет|голодн|їжа|їжу"),
    hint: "Тема — обід: поклич автора обідати, скажи, що в тебе на плиті й чому він мусить прийти негайно." },
  { key: "хахалі", re: W("хахал|кавалер|залиця|кохан|любов|заміж|жених|ухажер|роман[иа]?(?![\\p{L}])|дід|дєд"),
    hint: "Тема — хахалі: розкажи коротко про одного зі своїх колишніх кавалерів (вигаданого, з дев'яностих чи вісімдесятих) — з деталлю, від якої смішно." },
  { key: "гороскоп", re: W("гороскоп|зодіак|зірк|астролог|ретроград|меркурі"),
    hint: "Тема — гороскоп: дай авторові абсурдний гороскоп на сьогодні — які планети де стоять (у колясочній, на акції в АТБ) і чого остерігатись." },
  { key: "погода", re: W("погод|дощ|спек|холод|сніг|вітер|мороз"),
    hint: "Тема — погода: дай прогноз за своїми колінами, спиною й сусідами." },
  { key: "гроші", re: W("пенсі|грош|ціни|цін[аиу]|акці|зарплат|комуналк|кредит|долар|гривн"),
    hint: "Тема — гроші й пенсія: побурчи про ціни, пенсію й комуналку — з одним абсурдним розрахунком." },
  { key: "здоров'я", re: W("тиск|лікар|таблет|здоров|болить|аптек|поліклін|хвор"),
    hint: "Тема — здоров'я бабці: розкажи про свій тиск, коліна чи таблетки — як про подвиг. Про здоров'я автора не жартуй." },
  { key: "порада", re: W("порад|що робити|шо робити|як бути|підкажи|посовітуй|допоможи"),
    hint: "Тема — порада: дай життєву пораду з досвіду бабці — корисну, але смішну." },
  { key: "плітки", re: W("пліт|новин|що нового|шо нового|розкажи|хто там"),
    hint: "Тема — плітки: переказуй «новини двору» загально й вигадано, без імен і реальних фактів про людей." },
  { key: "пророцтво", re: W("що буде|шо буде|завтра|передбач|пророк|майбутн|ворож"),
    hint: "Тема — пророцтво: передбач авторові чи двору щось пафосне й абсурдне." },
];
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

// A member who speaks but is missing from «Дійові особи» (Nina, 24.09.2026) gets a neutral line there. Only real
// senders are checked, so a stray "Висновок:" never becomes a character.
export function castFix(play, names) {
  const start = play.indexOf("Дійові особи:");
  if (start < 0) return play;
  const end = play.indexOf("\n\n", start);
  const block = play.slice(start, end < 0 ? undefined : end);
  const cast = block.split("\n").slice(1).map((l) => l.split(" — ")[0].trim());
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const missing = names.filter((n) => !cast.includes(n) && new RegExp(`^${esc(n)}(?: \\([^)\\n]*\\))?:`, "m").test(play));
  if (!missing.length) return play;
  const add = missing.map((n) => `${n} — голос із натовпу`).join("\n");
  const others = block.lastIndexOf("\nта інші");
  const fixed = others < 0 ? `${block}\n${add}` : `${block.slice(0, others)}\n${add}${block.slice(others)}`;
  return play.slice(0, start) + fixed + play.slice(start + block.length);
}

// Every label the model sees in its input and could echo back: block headers, plan fields, template slots,
// chat markers, reply hints. Whole lines for headers and fields, the marker itself for inline ones.
const SERVICE_LINE = new RegExp(
  "^\\s*(?:(?:ОБРАЗ ДНЯ|ОБСЯГ|ПЛАН ДНЯ|ЧАТ|СТАТЬ|ПІДПИСИ УЧАСНИКІВ|ТЕМИ|ЩО РОБИВ|КОНТЕКСТ ПОПЕРЕДНЬОГО ВИПУСКУ|ЧАСТИНА \\d+ з \\d+)(?![\\p{L}]).*" +
  "|(?:Учасники|Температура|Хронологія|Чим закінчилось|Найкращі фрази)\\s*:.*" +
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

// Everything the model writes goes through this before Telegram: no pings, no placeholders, no service labels,
// no foreign scripts.
export const tidy = (text) =>
  SERVICE_INLINE.reduce(
    (t, re) => t.replace(re, ""),
    unmention(text).replace(/\[(?:номер телефону|номер картки|email|посилання)\]/g, "…").replace(/«{2,}/g, "«").replace(/»{2,}/g, "»")
      .replace(/«<([^<>»\n]*)>»/g, "«$1»") // the template's «<назва>» copied verbatim (24.09.2026)
      .replace(SERVICE_LINE, ""),
  )
    // Letters of other scripts ("дешевимกาแฟ" — Thai for coffee, 24.09.2026) are dropped; only Cyrillic and Latin stay.
    .replace(/(?:(?![\p{Script=Cyrillic}\p{Script=Latin}])\p{L}\p{M}*)+/gu, "").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n");

// She answers only to her @handle. Words («бабця», «бот»…), replies to her and /commands no longer call her (24.09.2026).
export const addressesBot = (text) => /(?<![\w/])@babtsya_z_altanky_bot\b/i.test(text); // not /cmd@babtsya…

export function finalize(play) {
  play = tidy(play).replace(/^\s*(?:ОБРАЗ ДНЯ|ОБСЯГ)\s*:.*\n?/gimu, "").replace(/([^\n])\n(\(Сцена)/g, "$1\n\n$2");
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
  assert.equal(grumbleSection(1290, 10), "вечір");
  assert.equal(grumbleSection(750, null), "обід");
  const neighbourDays = ["2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28"].map(neighbourMinute);
  assert.ok(neighbourDays.every((m) => m >= 540 && m <= 1290 && m % 30 === 0 && !GRUMBLE_SLOTS.includes(m)), String(neighbourDays));
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
  const mp = mentionPrefix([{ name: "Taras", uid: 1 }, { name: "Hnat", uid: 2 }]);
  assert.equal(mp.text, "Taras, Hnat, ");
  assert.deepEqual(mp.entities.map((e) => [mp.text.slice(e.offset, e.offset + e.length), e.user.id]), [["Taras", 1], ["Hnat", 2]]);
  assert.deepEqual(mentionPrefix([]), { text: "", entities: [] });
  for (const t of ["@babtsya_z_altanky_bot тупа корова", "ану шо скажеш @babtsya_z_altanky_bot"]) assert.ok(addressesBot(t), t);
  for (const t of ["Бабця, пиздани дєда!", "цей бот тупий", "/babtsya", "/roast@babtsya_z_altanky_bot", "ну й що"]) assert.ok(!addressesBot(t), t);
  assert.equal(tidy("Taras, @some_nick каже кава กาแฟ"), "Taras, some_nick каже кава ");
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
  assert.equal(dropName("Іди спати.", "Taras"), "Іди спати.");
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
  assert.equal(topicFor("@babtsya_z_altanky_bot а можна щоб обідать кликала?", 13)?.key, "обід");
  assert.equal(topicFor("@babtsya_z_altanky_bot а можна щоб обідать кликала?", 16), null);
  assert.equal(topicFor("@babtsya_z_altanky_bot і ще шоб про хахалєй сваїх розказувала", 18)?.key, "хахалі");
  assert.equal(topicFor("@babtsya_z_altanky_bot бабуля, шо по гороскопах?", 10)?.key, "гороскоп");
  assert.equal(topicFor("@babtsya_z_altanky_bot", 10), null);
  assert.equal(topicFor("@babtsya_z_altanky_bot ну шо скажеш", 10), null);
  assert.ok(REPLY_MOVES.rude.length >= 10 && REPLY_MOVES.wise.length >= 20 && IMAGES.length >= 50);
  assert.equal(dedupLoop("a\n".repeat(10) + "b"), "a\na\na");
  assert.deepEqual(lengthTarget(10), [600, 900]);
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
