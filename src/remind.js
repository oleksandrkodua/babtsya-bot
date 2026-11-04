// "@бабця нагадай Василю зварити капусняк післязавтра" (04.11.2026): she answered "нагадаю" and had nothing to do it with.
// Pure parsing, no Cloudflare: the Worker stores the result in `reminders` and the cron tick posts it when due.
// Words come in Ukrainian, Russian, surzhyk and Latin; the imperative or infinitive only ("це нагадує мені…" is not a request).
const BOT = /@babtsya_z_altanky_bot/gi;
const VERB = /(?<![\p{L}])(?:нагад(?:ай|айте|ати|уй|уйте|аєш|аєте|айка)|нагадала\s+б|нагадав\s+би|напомн(?:[иі](?:те|ть|шь)?|ать)|напом[иі]най(?:те)?|remind(?:er|me)?|ремайнд\p{L}*|не\s+(?:дай|давай|дайте)\s+(?:\p{L}+\s+)?(?:(?:за|по)бути|забыть))(?![\p{L}])/iu;
// "постав нагадування / поставь напоминалку / set a reminder" — the noun counts only after a doing-verb.
const NOUN = /(?:постав\p{L}*|створ\p{L}*|создай|зроби|сделай|додай|добав\p{L}*|set)\s+(?:мені\s+|мне\s+|йому\s+|їй\s+)?(?:нагадуван\p{L}*|нагадалк\p{L}*|напоминал\p{L}*|напоминан\p{L}*|будильник\p{L}*|таймер\p{L}*)/iu;
export const isRemind = (raw) => VERB.test(raw) || NOUN.test(raw);

const SELF = /^(?:мені|мне|мєні|менє|меня|собі|себе|я)$/iu, ALL = /^(?:всім|всем|усім|всіх|всех|чату|чат|групі|альтанці)$/iu, HIM = /^(?:йому|їй|ему|ей|ёму)$/iu;
const FILLER = /(?<![\p{L}])(?:будь\s*-?\s*ласка|пжлст|пліз|плиз|плз|please|pls)(?![\p{L}])/giu;
const DAYWORD = { "післязавтра": 2, "послезавтра": 2, "завтра": 1, "сьогодні": 0, "сегодня": 0 };
const WEEKDAYS = [["неділ", "воскрес"], ["понеділ", "понедел"], ["вівтор", "вторник"], ["серед", "сред"], ["четвер"], ["п'ятниц", "пятниц", "п’ятниц", "пʼятниц"], ["субот"]];
const PARTS = [[/(?<![\p{L}])(?:вранці|зранку|утром|утра|ранку)(?![\p{L}])/iu, 8], [/(?<![\p{L}])(?:після\s+обіду|после\s+обеда)(?![\p{L}])/iu, 15], [/(?<![\p{L}])(?:вдень|днем|опівдні|в\s+обід|на\s+обід|в\s+обед)(?![\p{L}])/iu, 13], [/(?<![\p{L}])(?:ввечері|увечері|вечером|ввечір|вечора|вечера)(?![\p{L}])/iu, 19], [/(?<![\p{L}])(?:вночі|ночью|ночі)(?![\p{L}])/iu, 22]];
const DEFAULT_HOUR = 10;

// Cyrillic → Latin skeleton, so "Василю" finds "Vasyl" (the Telegram name) in any case ending.
const TR = { а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "e", ж: "zh", з: "z", и: "y", і: "i", ї: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ю: "yu", я: "ya", ы: "y", э: "e", ё: "e", ь: "", ъ: "", "'": "", "’": "", "ʼ": "" };
const key = (s) => [...s.toLowerCase()].map((c) => TR[c] ?? c).join("").replace(/[^a-z]/g, "");
const near = (a, b) => {
  const [x, y] = [key(a), key(b)], min = Math.min(x.length, y.length);
  if (min < 2 || Math.abs(x.length - y.length) > 3) return false; // a case ending, not another name
  let cp = 0;
  while (cp < min && x[cp] === y[cp]) cp++;
  return cp >= (min <= 4 ? min - 1 : min - 2);
};
// The one known name (or one of its words) that the written form points at; ambiguity returns null.
export function matchName(word, names) {
  const hit = names.filter((n) => near(word, n) || n.split(/\s+/).some((p) => p.length > 2 && near(word, p)));
  return hit.length === 1 ? hit[0] : null;
}

// raw: the tagged message. Returns null (not a reminder), { ask } (what is missing) or { dueMs, target, self, all, what }.
export function parseRemind(raw, { nowMs, offsetSec, author, other = null, names = [] }) {
  if (!isRemind(raw)) return null;
  let t = ` ${raw.replace(BOT, " ").replace(/\s+/g, " ")} `;
  const cut = (re) => { const m = re.exec(t); if (m) t = t.replace(re, " "); return m; };
  cut(VERB) || cut(NOUN);
  cut(FILLER);
  const low = () => t.toLowerCase();
  const local = new Date(nowMs + offsetSec * 1000), ymd = [local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()];
  const toMs = (days, h, min = 0) => Date.UTC(ymd[0], ymd[1], ymd[2] + days, h, min) - offsetSec * 1000;
  let dueMs = null, days = null, hour = null, minute = 0;

  const rel = cut(/(?<![\p{L}])через\s+(?:(\d+(?:[.,]\d+)?)|(пару|пар|кілька|несколько|півтори|полтора|пів|пол))?\s*(хв\p{L}*|мин\p{L}*|год\p{L}*|час\p{L}*|дн\p{L}*|дней|ден\p{L}*|тижн\p{L}*|тиждень|недел\p{L}*)(?![\p{L}])/iu);
  if (rel) {
    const n = rel[1] ? Number(rel[1].replace(",", ".")) : { пару: 2, пар: 2, кілька: 3, несколько: 3, півтори: 1.5, полтора: 1.5, пів: 0.5, пол: 0.5 }[rel[2]?.toLowerCase()] ?? 1;
    const u = rel[3].toLowerCase(), unit = /^(хв|мин)/.test(u) ? 60 : /^(год|час)/.test(u) ? 3600 : /^(тижн|тиждень|недел)/.test(u) ? 7 * 86400 : 86400;
    dueMs = nowMs + n * unit * 1000;
  }
  const dm = !rel && cut(/(?<![\p{L}])(післязавтра|послезавтра|завтра|сьогодні|сегодня)(?![\p{L}])/iu);
  if (dm) days = DAYWORD[dm[1].toLowerCase()];
  if (!rel && days == null) {
    const wd = cut(/(?<![\p{L}])(?:в|у|на|до)?\s*(понеділ\p{L}*|понедел\p{L}*|вівтор\p{L}*|вторник\p{L}*|серед\p{L}*|сред\p{L}*|четвер\p{L}*|п['’ʼ]?ятниц\p{L}*|пятниц\p{L}*|субот\p{L}*|неділ\p{L}*|воскресен\p{L}*)/iu);
    if (wd) {
      const w = wd[1].toLowerCase(), i = WEEKDAYS.findIndex((stems) => stems.some((s) => w.startsWith(s)));
      if (i >= 0) days = ((i - local.getUTCDay() + 6) % 7) + 1; // strictly ahead: a weekday named today means next week
    }
  }
  if (!rel) {
    const tm = cut(/(?<![\p{L}\d])(?:о|в|у|к|на)?\s*(\d{1,2})[:.](\d{2})(?![\d])/iu) || cut(/(?<![\p{L}\d])(?:о|в|у|к|на)\s+(\d{1,2})(?:\s*(?:год\p{L}*|ч))?(?![\p{L}\d:.])/iu);
    if (tm) { hour = Number(tm[1]); minute = Number(tm[2] || 0); }
    for (const [re, h] of PARTS) {
      const pm = cut(re);
      if (pm) { if (hour == null) hour = h; else if (h >= 13 && hour < 12) hour += 12; break; }
    }
    if (hour != null && (hour > 23 || minute > 59)) return { ask: "when" };
    if (days != null || hour != null) {
      if (days == null) { days = 0; if (toMs(0, hour, minute) <= nowMs) days = 1; }
      dueMs = days === 0 && hour == null ? nowMs + 2 * 3600e3 : toMs(days, hour ?? DEFAULT_HOUR, minute);
    }
  }
  if (dueMs == null || dueMs <= nowMs + 60e3 || dueMs > nowMs + 366 * 86400e3) return { ask: "when" };

  // Whom: what stands right after the verb. A capitalized word, a known name or a @username is the person.
  t = t.replace(/\s+/g, " ").replace(/^[\s,:;—-]+/, "");
  const first = /^(\S+)/.exec(t)?.[1].replace(/[,:;.!?]+$/, "") ?? "";
  let target = author, self = true, all = false, rest = t;
  const takes = (who) => { target = who; self = false; rest = t.slice(first.length + (t[first.length] === " " ? 1 : 0)); };
  if (SELF.test(first)) rest = t.slice(first.length);
  else if (ALL.test(first)) { all = true; self = false; target = ""; rest = t.slice(first.length); }
  else if (HIM.test(first)) { if (!other?.name) return { ask: "who" }; takes(other.name); }
  else if (/^@\w{3,}$/.test(first)) takes(first);
  else if (/^\p{Lu}\p{Ll}[\p{L}'’ʼ-]*$/u.test(first) || (first.length > 2 && matchName(first, names))) takes(first);
  rest = rest.replace(/^[\s,:;—-]+/, "").replace(/^(?:що|шо|щоб|шоб|что|чтобы|чтоб)\s+/iu, "").replace(/[\s,;:—-]+$/, "").trim();
  if (rest.length < 3) return { ask: "what" };
  return { dueMs, target, self, all, what: rest.slice(0, 200) };
}

// When, in Kyiv time: "06.11 о 10:00".
export function whenLabel(dueMs, offsetSec) {
  const d = new Date(dueMs + offsetSec * 1000), p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} о ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
export const REMIND_ASK = {
  when: "Коли нагадувати? Скажи «завтра», «через 2 години», «у п'ятницю о 18:00» — бабця не ворожка.",
  what: "А що саме нагадувати? Бабця пам'ятає багато, але не те, чого їй не сказали.",
  who: "Кому нагадувати? Напиши ім'я, або «мені», або відповідай на повідомлення цієї людини.",
};
export const REMIND_MANY = "Забагато нагадувань на одну голову. Спершу нехай те, що висить, відбреше своє.";
const ACK = [
  (w, who, what) => `Записала. ${w} нагадаю ${who}: «${what}». Бабця слово тримає, на відміну від депутатів.`,
  (w, who, what) => `Зафіксувала в зошиті. ${w} нагадаю ${who}: «${what}». Не забуду — в мене пам'ять, як у сейфі.`,
];
// The cron wakes at :00 and :30 only, so a reminder goes out at the first tick at or after its time (04.11.2026: "через 5 хвилин"
// said 13:47 and the post could only come at 14:00). The answer names that tick and says why.
export const tickMs = (ms) => Math.ceil(ms / 1800e3) * 1800e3;
export const remindAck = (rem, offsetSec, pick = (l) => l[Math.floor(Math.random() * l.length)]) => {
  const tick = tickMs(rem.dueMs), late = tick !== rem.dueMs;
  const text = pick(ACK)(whenLabel(tick, offsetSec), rem.all ? "усім" : rem.self ? "тобі" : rem.target, rem.what);
  return late ? `${text} Рівно о ${whenLabel(rem.dueMs, offsetSec).slice(-5)} не вийде: бабця заглядає в зошит лише о :00 і :30, тож спрацюю на найближчому такті.` : text;
};
// The post when due. who: the author's name for "someone asked"; self-reminders just say so.
const DUE = [
  (what, from) => `Нагадую${from ? ` від ${from}` : ", як просили"}: ${what}. Бабця не забула, на відміну від декого.`,
  (what, from) => `Прийшов час. ${from ? `${from} просив(ла) нагадати` : "Ти просив(ла) нагадати"}: ${what}. Не подякуєш — не треба.`,
  (what, from) => `Ану слухайте сюди${from ? `, від ${from}` : ""}: ${what}. Двічі бабця не повторює.`,
];
export const remindText = (what, from, pick = (l) => l[Math.floor(Math.random() * l.length)]) => pick(DUE)(what, from);

if (import.meta.main) {
  const { strict: assert } = await import("node:assert");
  const off = 7200, now = Date.UTC(2026, 10, 4, 9, 34); // 04.11.2026 11:34 Kyiv, a Wednesday
  const run = (raw, extra = {}) => parseRemind(`@babtsya_z_altanky_bot ${raw}`, { nowMs: now, offsetSec: off, author: "Автор", names: ["Vasyl", "Автор", "Олександр", "Оля"], ...extra });
  const at = (r) => whenLabel(r.dueMs, off);
  // the 04.11 case
  let r = run("нагадай Василю зварити капусняк післязавтра");
  assert.equal(at(r), "06.11 о 10:00"); assert.equal(r.target, "Василю"); assert.equal(r.what, "зварити капусняк"); assert.equal(r.self, false);
  assert.equal(matchName("Василю", ["Vasyl", "Автор"]), "Vasyl");
  assert.equal(matchName("Олі", ["Оля", "Олександр"]), "Оля");
  assert.equal(matchName("Олександру", ["Олександр", "Оля"]), "Олександр");
  assert.equal(matchName("Ольга", ["Оля"]), null);
  // verbs: uk, ru, surzhyk, Latin, noun forms; "це нагадує" is not a request
  for (const v of ["нагадай", "нагадайте", "напомни", "напомніть", "напоминай", "нагадуй", "remind me", "не дай мені забути", "не давай забыть", "поставь напоминалку", "постав нагадування"]) assert.ok(isRemind(`@бот ${v} щось завтра`), v);
  for (const v of ["це нагадує мені дитинство", "нагадування було вчора", "нагадаю потім", "дай рецепт"]) assert.ok(!isRemind(v), v);
  // time
  assert.equal(at(run("нагадай мені купити хліб через 2 години")), "04.11 о 13:34");
  assert.equal(at(run("напомни мне позвонить через полчаса")), "04.11 о 12:04");
  assert.equal(at(run("нагадай мені купити хліб завтра о 18:30")), "05.11 о 18:30");
  assert.equal(at(run("нагадай мені купити хліб завтра ввечері")), "05.11 о 19:00");
  assert.equal(at(run("нагадай мені позвонить в 7 вечера")), "04.11 о 19:00");
  assert.equal(at(run("нагадай мені позвонить в 9")), "05.11 о 09:00"); // already past today
  assert.equal(at(run("нагадай мені полити квіти у п'ятницю")), "06.11 о 10:00");
  assert.equal(at(run("нагадай мені полити квіти в середу о 8")), "11.11 о 08:00"); // today is Wednesday → next one
  assert.equal(at(run("нагадай мені полити квіти через тиждень")), "11.11 о 11:34");
  assert.equal(run("нагадай мені полити квіти").ask, "when");
  assert.equal(run("нагадай завтра").ask, "what");
  assert.equal(run("нагадай йому завтра купити хліб").ask, "who");
  // whom
  r = run("нагадай йому завтра купити хліб", { other: { name: "Оля", text: "ну" } }); assert.equal(r.target, "Оля");
  r = run("нагадай мені завтра купити хліб"); assert.equal(r.self, true); assert.equal(r.target, "Автор");
  r = run("нагадай завтра купити хліб"); assert.equal(r.self, true);
  r = run("нагадай всім завтра, що збори о 18:00"); assert.equal(r.all, true); assert.equal(r.what, "збори");
  r = run("нагадай @vasya_k завтра віддати борг"); assert.equal(r.target, "@vasya_k");
  r = run("нагадай олександру завтра віддати борг"); assert.equal(r.target, "олександру");
  r = run("нагадай Василю, що треба зварити капусняк післязавтра, будь ласка"); assert.equal(r.what, "треба зварити капусняк");
  assert.ok(remindAck(run("нагадай Василю зварити капусняк післязавтра"), off, (l) => l[0]).includes("06.11 о 10:00"));
  assert.ok(!remindAck(run("нагадай Василю зварити капусняк післязавтра"), off, (l) => l[0]).includes("не вийде")); // 10:00 is a tick
  const late = remindAck(run("нагадай мені тест через 8 хвилин"), off, (l) => l[0]); // 11:42 → tick 12:00
  assert.ok(late.includes("04.11 о 12:00 нагадаю тобі") && late.includes("Рівно о 11:42 не вийде") && late.includes(":00 і :30"));
  assert.ok(remindText("зварити капусняк", "Автор", (l) => l[0]).includes("від Автор"));
  console.log("remind: самоперевірка ок");
}
