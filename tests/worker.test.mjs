import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test, afterEach } from "node:test";

// Load the real Worker with text imports in Node; every external call below is a mock.
const root = new URL("../", import.meta.url);
const read = (file) => readFileSync(new URL(file, root), "utf8");
let source = read("src/index.js").replace(/import (\w+) from "\.\.\/prompts\/([^"\n]+)";/g,
  (_, name, file) => `const ${name} = ${JSON.stringify(read(`prompts/${file}`))};`)
  .replace('"./pipeline.js"', JSON.stringify(new URL("src/pipeline.js", root).href))
  .replace('"../poll.js"', JSON.stringify(new URL("poll.js", root).href));
source += "\nexport { ingest, digest, ai, look, klein, compose, answer, draw64, closePoll, poll, pollText, committee, chronicle, left, grumble };";
const worker = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

class DB {
  constructor(schema = read("schema.sql")) {
    this.sql = new DatabaseSync(":memory:");
    this.sql.exec(schema);
    this.hooks = {};
  }
  prepare(query) {
    const db = this;
    return {
      args: [],
      bind(...args) { this.args = args; return this; },
      async all() {
        const results = db.sql.prepare(query).all(...this.args);
        await db.hooks.all?.(query, results);
        return { results };
      },
      async first(column) { const row = db.sql.prepare(query).get(...this.args); return row ? column ? row[column] : row : null; },
      async run() { await db.hooks.run?.(query); return this.exec(); },
      exec() { return { meta: { changes: Number(db.sql.prepare(query).run(...this.args).changes) } }; },
    };
  }
  async batch(statements) {
    await this.hooks.batch?.();
    this.sql.exec("BEGIN");
    try {
      const results = statements.map((s) => s.exec());
      this.sql.exec("COMMIT");
      return results;
    } catch (error) { this.sql.exec("ROLLBACK"); throw error; }
  }
}

const completion = (text) => ({ response: text, usage: { prompt_tokens: 10, completion_tokens: 10 } });
const plan = "ТЕМИ\n1. Ремонт лавки\nУчасники: TesterA, TesterB\nХронологія: пофарбували лавку";
const play = "«Лавка»\n\nДійові особи:\nTesterA — фарбує лавку\nTesterB — приносить фарбу\n\n(Сцена 1. Двір.)\nTesterA: Лавку пофарбуємо до обіду.\nTesterB: А потім будемо пити чай.\n\nМораль: Фарба сохне, а чай стигне.";
const now = () => Math.floor(Date.now() / 1000);
const originalFetch = globalThis.fetch, originalNow = Date.now;
globalThis.fetch = async () => { throw new Error("Network is disabled in Worker tests"); };
afterEach(() => {
  Date.now = originalNow;
  globalThis.fetch = async () => { throw new Error("Network is disabled in Worker tests"); };
});
process.on("exit", () => { globalThis.fetch = originalFetch; });

function fixture(db = new DB()) {
  const calls = [], sent = [];
  const env = { DB: db, GROUP_CHAT_ID: "SYNTHETIC_GROUP", TEST_CHAT_ID: "999", TEST_MODE: "0",
    WEBHOOK_SECRET: "test-secret", TELEGRAM_BOT_TOKEN: "test-token", ALIASES: "", SAME_PEOPLE: "", TITLES: "", FEMALE_NAMES: "",
    AI: { async run(model, args) {
      calls.push(args);
      const system = args.messages?.[0]?.content || "";
      return completion(system.startsWith("Ти — уважний секретар") ? plan : system.startsWith("Ти — Бабця з альтанки, бот") ? play : "НЕМАЄ");
    } },
  };
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /^https:\/\/api\.telegram\.org\//);
    const method = String(url).split("/").at(-1);
    const body = options.body instanceof FormData ? {} : JSON.parse(options.body);
    sent.push({ method, body });
    return Response.json({ ok: true, result: { message_id: sent.length, chat: { id: body.chat_id } } });
  };
  return { db, env, calls, sent };
}

function seed(db, count = 60) {
  const insert = db.sql.prepare("INSERT INTO messages(message_id, ts, name, text) VALUES (?, ?, ?, ?)");
  for (let id = 1; id <= count; id++) insert.run(id, now() - 100 + id, id % 2 ? "TesterA" : "TesterB", `Ремонт лавки, запис ${id}.`);
}
const plays = (sent) => sent.filter((r) => r.method === "sendMessage" && r.body.text.includes("Фарба сохне"));

test("all text AI inputs redact contacts without removing names, language, swearing or ordinary numbers", async () => {
  const { env, calls } = fixture();
  const contacts = "Тел.: 050-000-00-00; картка: 4444 3333 2222 1111; email: synthetic@example.test; https://example.test/private";
  const ordinary = "TesterA, кличка Лис, бляха: 2026 рік, 1400 нейронів, 3:2.";
  await worker.ai(env, `System ${contacts}`, `${ordinary}\n${contacts}`, 0.2);
  const text = JSON.stringify(calls[0].messages);
  for (const secret of ["050-000-00-00", "4444 3333 2222 1111", "synthetic@example.test", "https://example.test/private"]) assert.ok(!text.includes(secret));
  assert.ok(text.includes(ordinary));
  for (const label of ["номер телефону", "номер картки", "email", "посилання"]) assert.ok(text.includes(label));
});

test("late arrivals during snapshot and after commit are consumed by the next digest only", async () => {
  const { db, env, sent } = fixture(); seed(db);
  let injected = false;
  db.hooks.all = (q) => {
    if (q.includes("FROM messages WHERE processed = 0") && !injected) {
      injected = true;
      db.sql.prepare("INSERT INTO messages(message_id, ts, name, text) VALUES (900, ?, 'TesterA', 'Запізнілий факт')").run(now() - 200);
    }
  };
  await worker.digest(env, "2026-10-31", "manual");
  assert.equal(db.sql.prepare("SELECT processed FROM messages WHERE message_id=900").get()?.processed, 0);
  db.sql.prepare("INSERT INTO messages(message_id, ts, name, text) VALUES (901, ?, 'TesterB', 'Ще один факт')").run(now() - 300);
  const again = await worker.digest(env, "2026-10-31", "manual");
  assert.match(again, /2 повідомлень/);
  assert.equal(db.sql.prepare("SELECT count(*) n FROM messages WHERE processed=0").get().n, 0);
  assert.match(await worker.digest(env, "2026-10-31", "manual"), /нема повідомлень/);
  assert.equal(plays(sent).length, 2);
});

test("manual/manual consuming runs share one lock", async () => {
  const { db, env, sent } = fixture(); seed(db);
  const results = await Promise.all([worker.digest(env, "2026-10-31", "manual"), worker.digest(env, "2026-10-31", "manual")]);
  assert.equal(plays(sent).length, 1);
  assert.ok(results.some((s) => s.includes("вже готується")));
});

test("cron/manual consuming runs share one lock", async () => {
  const time = Date.parse("2026-10-31T11:00:00Z"); Date.now = () => time;
  const { db, env, sent } = fixture(); seed(db);
  await Promise.all([worker.default.scheduled({ scheduledTime: time }, env), worker.digest(env, "2026-10-31", "manual")]);
  assert.equal(plays(sent).length, 1);
  assert.equal(db.sql.prepare("SELECT count(*) n FROM digests").get().n, 1);
});

test("a second scheduled invocation rechecks edition completion under the lock", async () => {
  const { db, env, sent } = fixture(); seed(db);
  await worker.digest(env, "2026-10-31", "midday");
  db.sql.prepare("INSERT INTO messages(message_id, ts, name, text) VALUES(900, ?, 'TesterA', 'Наступна подія')").run(now() - 1);
  assert.match(await worker.digest(env, "2026-10-31", "midday"), /вже опубліковано/);
  assert.equal(plays(sent).length, 1);
  assert.equal(db.sql.prepare("SELECT processed FROM messages WHERE message_id=900").get().processed, 0);
});

test("keep preview still posts to the group and does not consume or acquire a lock", async () => {
  const { db, env, sent } = fixture(); seed(db);
  db.sql.prepare("INSERT INTO digest_lock VALUES (1, 'other-run', ?)").run(now() + 1200);
  await worker.digest(env, "2026-10-31", "manual", true);
  assert.equal(plays(sent)[0].body.chat_id, env.GROUP_CHAT_ID);
  assert.equal(db.sql.prepare("SELECT count(*) n FROM messages WHERE processed=0").get().n, 60);
  assert.equal(db.sql.prepare("SELECT count(*) n FROM digests").get().n, 0);
  assert.equal(db.sql.prepare("SELECT token FROM digest_lock").get().token, "other-run");
});

test("failed Telegram send keeps pending input and releases the lock for retry", async () => {
  const { db, env } = fixture(); seed(db);
  globalThis.fetch = async () => Response.json({ ok: false, description: "synthetic rejection" });
  await assert.rejects(worker.digest(env, "2026-10-31", "manual"), /synthetic rejection/);
  assert.equal(db.sql.prepare("SELECT count(*) n FROM messages WHERE processed=0").get().n, 60);
  assert.equal(db.sql.prepare("SELECT count(*) n FROM digests").get().n, 0);
  assert.equal(db.sql.prepare("SELECT count(*) n FROM digest_lock").get().n, 0);
  const { sent } = fixture(db);
  await worker.digest(env, "2026-10-31", "manual");
  assert.equal(plays(sent).length, 1);
});

test("empty generation sends the existing stub and keeps pending input", async () => {
  const { db, env, sent } = fixture(); seed(db);
  env.AI.run = async () => completion("");
  await worker.digest(env, "2026-10-31", "manual");
  assert.equal(sent.filter((s) => s.method === "sendMessage").length, 1);
  assert.equal(db.sql.prepare("SELECT count(*) n FROM messages WHERE processed=0").get().n, 60);
  assert.equal(db.sql.prepare("SELECT count(*) n FROM digest_lock").get().n, 0);
});

test("a crashed run's expired lock is recoverable", async () => {
  const { db, env, sent } = fixture(); seed(db);
  db.sql.prepare("INSERT INTO digest_lock VALUES (1, 'expired', ?)").run(now() - 1);
  await worker.digest(env, "2026-10-31", "manual");
  assert.equal(plays(sent).length, 1);
  assert.equal(db.sql.prepare("SELECT count(*) n FROM digest_lock").get().n, 0);
});

test("a stale generator cannot publish or delete a newer owner's lock", async () => {
  const { db, env, sent } = fixture(); seed(db);
  const run = env.AI.run; let stolen = false;
  env.AI.run = async (...args) => {
    if (!stolen) { stolen = true; db.sql.prepare("UPDATE digest_lock SET token='replacement'").run(); }
    return run(...args);
  };
  await assert.rejects(worker.digest(env, "2026-10-31", "manual"), /втрачено замок/);
  assert.equal(plays(sent).length, 0);
  assert.equal(db.sql.prepare("SELECT count(*) n FROM messages WHERE processed=0").get().n, 60);
  assert.equal(db.sql.prepare("SELECT token FROM digest_lock").get().token, "replacement");
});

test("expired generation stops before publication even without a replacement owner", async () => {
  const start = originalNow(); let clock = start; Date.now = () => clock;
  const { db, env, sent } = fixture(); seed(db);
  const run = env.AI.run;
  env.AI.run = async (...args) => { clock = start + 21 * 60 * 1000; return run(...args); };
  await assert.rejects(worker.digest(env, "2026-10-31", "manual"), /втрачено замок/);
  assert.equal(plays(sent).length, 0);
  assert.equal(db.sql.prepare("SELECT count(*) n FROM messages WHERE processed=0").get().n, 60);
});

test("snapshot acknowledgement handles more than 100 IDs and retains 20 told rows", async () => {
  const { db, env } = fixture(); seed(db, 150);
  // Keep all synthetic send timestamps before the snapshot.
  db.sql.prepare("UPDATE messages SET ts=?").run(now() - 1);
  await worker.digest(env, "2026-10-31", "manual");
  assert.equal(db.sql.prepare("SELECT count(*) n FROM messages").get().n, 20);
  assert.equal(db.sql.prepare("SELECT count(*) n FROM messages WHERE processed=0").get().n, 0);
});

test("redelivery after deletion does not resurrect a told row; edits still update pending rows", async () => {
  const { db, env } = fixture();
  const message = { message_id: 1, date: now() - 200, chat: { id: env.GROUP_CHAT_ID }, from: { id: 123, first_name: "TesterA" }, text: "Стара подія" };
  const ctx = { waitUntil() { throw new Error("No tag expected"); } };
  await worker.ingest(env, { message }, ctx);
  await worker.ingest(env, { edited_message: { ...message, text: "Правка до випуску" } }, ctx);
  assert.equal(db.sql.prepare("SELECT text FROM messages WHERE message_id=1").get().text, "Правка до випуску");
  for (let id = 2; id <= 25; id++) db.sql.prepare("INSERT INTO messages(message_id, ts, name, text) VALUES(?, ?, 'TesterB', 'Новіше')").run(id, now() - 100 + id);
  await worker.digest(env, "2026-10-31", "manual");
  assert.equal(db.sql.prepare("SELECT 1 FROM messages WHERE message_id=1").get(), undefined);
  await worker.ingest(env, { message }, ctx);
  assert.equal(db.sql.prepare("SELECT 1 FROM messages WHERE message_id=1").get(), undefined);
});

test("live tag and quoted/news context reach AI redacted; nontriggers stay silent", async () => {
  const { db, env, calls } = fixture();
  const jobs = [], ctx = { waitUntil(job) { jobs.push(job); } };
  const message = { message_id: 700, date: now(), chat: { id: env.GROUP_CHAT_ID }, from: { id: 123, first_name: "TesterA" },
    text: "@babtsya_z_altanky_bot поясни тест: 050-000-00-00",
    reply_to_message: { message_id: 600, from: { id: 456, first_name: "TesterB" }, text: "synthetic@example.test" } };
  await worker.ingest(env, { message }, ctx); await Promise.all(jobs);
  assert.ok(calls.length > 0);
  assert.ok(!JSON.stringify(calls).includes("050-000-00-00"));
  assert.ok(!JSON.stringify(calls).includes("synthetic@example.test"));
  jobs.length = 0; calls.length = 0;
  await worker.ingest(env, { message: { ...message, message_id: 701, reply_to_message: { ...message.reply_to_message,
    forward_origin: { type: "channel", chat: { title: "Synthetic news" } }, text: "https://example.test/private" } } }, ctx);
  await Promise.all(jobs);
  assert.ok(!JSON.stringify(calls).includes("https://example.test/private"));
  for (const [i, text] of ["бабця, бот", "/command", "Привіт"].entries()) {
    jobs.length = 0;
    await worker.ingest(env, { message: { ...message, message_id: 800 + i, text } }, ctx);
    assert.equal(jobs.length, 0);
  }
  assert.equal(db.sql.prepare("SELECT count(*) n FROM messages WHERE processed=0").get().n, 4);
});

test("image prompts and vision descriptions redact text contacts", async () => {
  const { env } = fixture();
  env.AI.run = async (_model, args) => {
    const form = await new Request("https://synthetic.invalid", { method: "POST", body: args.multipart.body,
      headers: { "content-type": args.multipart.contentType }, duplex: "half" }).formData();
    assert.equal(form.get("prompt"), "На табличці [номер телефону]");
    return { image: "" };
  };
  await worker.klein(env, "На табличці 050-000-00-00");
  globalThis.fetch = async (url) => String(url).includes("/getFile") ? Response.json({ ok: true, result: { file_path: "synthetic.jpg" } }) : new Response(new Uint8Array([1, 2, 3]));
  env.AI.run = async () => completion("На фото написано synthetic@example.test");
  assert.equal(await worker.look(env, "synthetic-file"), "На фото написано [email]");
});

test("migration preserves all old rows as pending and seeds redelivery protection", () => {
  const legacy = new DB("CREATE TABLE messages(message_id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, name TEXT NOT NULL, tag TEXT, text TEXT NOT NULL); CREATE TABLE ticks(key TEXT PRIMARY KEY, ts INTEGER NOT NULL);");
  legacy.sql.exec("INSERT INTO messages VALUES (1, 100, 'TesterA', NULL, 'Контекст'); INSERT INTO messages VALUES (2, 90, 'TesterB', NULL, 'Запізніле');");
  legacy.sql.exec(read("migrations/0001-digest-queue.sql"));
  assert.equal(legacy.sql.prepare("SELECT count(*) n FROM messages WHERE processed=0").get().n, 2);
  assert.equal(legacy.sql.prepare("SELECT count(*) n FROM ticks WHERE key LIKE 'ingest|%'").get().n, 2);
  const fresh = new DB();
  for (const table of ["messages", "digest_lock"]) assert.deepEqual(legacy.sql.prepare(`PRAGMA table_info(${table})`).all(), fresh.sql.prepare(`PRAGMA table_info(${table})`).all());
});

test("an edit arriving after selection remains pending for the next digest", async () => {
  const { db, env } = fixture(); seed(db);
  let changed = false;
  db.hooks.all = (query) => {
    if (query.includes("FROM messages WHERE processed = 0") && !changed) {
      changed = true;
      db.sql.prepare("UPDATE messages SET text='Правка під час генерації' WHERE message_id=1").run();
    }
  };
  await worker.digest(env, "2026-10-31", "manual");
  assert.equal(db.sql.prepare("SELECT processed FROM messages WHERE message_id=1").get().processed, 0);
  assert.match(await worker.digest(env, "2026-10-31", "manual"), /1 повідомлень/);
});

test("contacts are redacted before reply and stored-message length cuts", async () => {
  const { env, calls } = fixture();
  const text = "а".repeat(495) + "050-000-00-00";
  await worker.compose(env, "TesterA", text, "");
  assert.ok(!JSON.stringify(calls).includes("050-"));
  const { messageText, replyPlan } = await import(new URL("src/pipeline.js", root));
  assert.ok(!messageText({ text: "а".repeat(795) + "050-000-00-00" }).includes("050-"));
  const raw = "@babtsya_z_altanky_bot Трамп";
  calls.length = 0;
  assert.equal((await worker.compose(env, "TesterA", raw, "")).text, replyPlan(raw).stock.text);
  assert.equal(calls.length, 0);
});

test("cron rechecks its threshold after a manual run has consumed the previously counted input", async () => {
  const time = Date.parse("2026-10-31T11:00:00Z"); Date.now = () => time;
  const { db, env, sent } = fixture(); seed(db);
  db.hooks.run = async (query) => {
    if (query.startsWith("INSERT INTO digest_lock")) {
      db.hooks.run = null;
      await worker.digest(env, "2026-10-31", "manual");
      db.sql.prepare("INSERT INTO messages(message_id, ts, name, text) VALUES(900, ?, 'TesterA', 'Новий факт')").run(now() - 1);
    }
  };
  await worker.default.scheduled({ scheduledTime: time }, env);
  assert.equal(plays(sent).length, 1);
  assert.equal(db.sql.prepare("SELECT processed FROM messages WHERE message_id=900").get().processed, 0);
});

const pipeline = await import(new URL('src/pipeline.js', root));
test('edit to noise removes stale pending text without resurrecting consumed messages', async () => {
  const {db, env}=fixture(); const ctx={waitUntil(){throw Error('unexpected tag');}};
  const message={message_id:12,date:now(),chat:{id:env.GROUP_CHAT_ID},from:{id:12,first_name:'TesterA'},text:'Старе оголошення'};
  await worker.ingest(env,{message},ctx);
  await worker.ingest(env,{edited_message:{...message,text:'😂'}},ctx);
  assert.equal(db.sql.prepare('SELECT count(*) n FROM messages').get().n,0);
  await worker.ingest(env,{edited_message:{...message,text:'Правка видаленого'}},ctx);
  assert.equal(db.sql.prepare('SELECT count(*) n FROM messages').get().n,0);
});

test('claim cleanup failure never reverses a successful insert decision', async () => {
  const {db}=fixture(); db.hooks.run=(q)=>{if(q.startsWith('DELETE FROM ticks'))throw Error('cleanup unavailable');};
  assert.equal(await pipeline.claim(db,'synthetic-key'),true);
  assert.equal(await pipeline.claim(db,'synthetic-key'),false);
});

test('truncated plans retry once; repeated truncation never consumes input', async () => {
  for(const recover of [false,true]) {
    const {db,env}=fixture();seed(db);let analyses=0;const run=env.AI.run;
    env.AI.run=async(model,args)=>{
      if(String(args.messages?.[0]?.content).startsWith('Ти — уважний секретар')) {
        analyses++;return recover&&analyses===2?completion(plan):{...completion('Обрив тем-'),finish_reason:'length'};
      }
      return run(model,args);
    };
    await worker.digest(env,'2026-11-01','manual');assert.equal(analyses,2);
    assert.equal(db.sql.prepare('SELECT count(*) n FROM messages WHERE processed=0').get().n,recover?0:60);
    if(!recover)assert.equal(db.sql.prepare('SELECT count(*) n FROM digests WHERE plan IS NOT NULL').get().n,0);
  }
});

test('completion flags remain local across interleaved model calls', async () => {
  const {db,env}=fixture();let release;const gate=new Promise(ok=>release=ok);const first={allowCut:true},second={allowCut:true};
  let calls=0;env.AI.run=async()=>++calls===1?{...completion('Перший\nобрив-'),finish_reason:'length'}:completion('Другий');
  let blocked=false;db.hooks.run=async(q)=>{if(q.startsWith('INSERT INTO spend')&&!blocked){blocked=true;await gate;}};
  const a=worker.ai(env,'one','one',0.2,10,0,Infinity,first);
  await new Promise(ok=>setImmediate(ok));
  await worker.ai(env,'two','two',0.2,10,0,Infinity,second);release();await a;
  assert.equal(first.cut,true);assert.equal(second.cut,false);
});

test('memory drops the raw truncated tail without deleting a complete preceding note', async () => {
  const {db,env}=fixture();env.PEOPLE_NOTES='1';
  db.sql.prepare('INSERT INTO digests VALUES(?,?,?,?)').run('2026-11-01','manual',plan,now());
  env.AI.run=async(_m,a)=>String(a.messages[0].content).includes('літописиця')?completion('- Давній мем'):
    {...completion('TesterA: повна нова нотатка\nобрив'),finish_reason:'length'};
  await worker.chronicle(env);
  assert.equal(db.sql.prepare('SELECT notes FROM people_notes WHERE name=?').get('TesterA').notes,'повна нова нотатка');
});

test('oversized moral fails safely and regular plays retain the moral within the hard limit', async () => {
  assert.equal(pipeline.finalize('«Тест»\n\nМораль: '+'слово '.repeat(800)),'');
  assert.ok(pipeline.finalize(play).length<=pipeline.HARD_LIMIT);
  const {db,env,sent}=fixture();seed(db);const run=env.AI.run;
  env.AI.run=async(m,a)=>String(a.messages?.[0]?.content).startsWith('Ти — Бабця з альтанки, бот')?completion(play+'\nМораль: '+'слово '.repeat(800)):run(m,a);
  await worker.digest(env,'2026-11-01','manual');
  assert.ok(sent.every(s=>!s.body.text||s.body.text.length<=pipeline.HARD_LIMIT));
  assert.equal(db.sql.prepare('SELECT count(*) n FROM messages WHERE processed=0').get().n,60);
});

test('multiple same-day polls survive and a broken older poll does not block closure', async () => {
  const {db,env}=fixture();await worker.poll(env);await worker.poll(env);
  assert.equal(db.sql.prepare('SELECT count(*) n FROM polls').get().n,2);
  db.sql.prepare('INSERT INTO polls(day,chat_id,message_id,zrada,peremoga) VALUES(?,?,?,?,?)').run('2026-01-01',env.GROUP_CHAT_ID,900,null,null);
  globalThis.fetch=async(_u,o)=>{const b=JSON.parse(o.body);return b.message_id===900?Response.json({ok:false,description:'synthetic missing poll'}):Response.json({ok:true,result:{options:[{text:'Зрада',voter_count:2},{text:'Перемога',voter_count:b.message_id===1?8:3}]}});};
  await worker.closePoll(env,'2099-01-01');
  const rows=db.sql.prepare('SELECT * FROM polls WHERE message_id<900 ORDER BY message_id').all();
  assert.deepEqual(rows.map(r=>r.peremoga),[8,3]);
  const {pollRemark}=await import(new URL('poll.js',root));
  assert.equal(await worker.pollText(env,rows[0].day),pollRemark({zrada:2,peremoga:8},new Date(rows[0].day+'T12:00:00Z').getUTCDay()===0?[{zrada:2,peremoga:8}]:undefined));
  db.sql.exec('UPDATE polls SET zrada=8,peremoga=2 WHERE message_id=2');
  assert.equal(await worker.pollText(env,rows[0].day),pollRemark({zrada:2,peremoga:8},new Date(rows[0].day+'T12:00:00Z').getUTCDay()===0?[{zrada:2,peremoga:8}]:undefined));
});

test('poll migration preserves references and counters and admits another poll on the same day',()=>{
  const legacy=new DB('CREATE TABLE polls(day TEXT PRIMARY KEY,chat_id TEXT NOT NULL,message_id INTEGER NOT NULL,zrada INTEGER,peremoga INTEGER);');
  legacy.sql.exec("INSERT INTO polls VALUES('2026-11-01','synthetic',1,2,3)");
  legacy.sql.exec('BEGIN');legacy.sql.exec(read('migrations/0002-poll-identities.sql'));legacy.sql.exec('COMMIT');
  legacy.sql.exec("INSERT INTO polls(day,chat_id,message_id,zrada,peremoga) VALUES('2026-11-01','synthetic',2,NULL,NULL)");
  assert.equal(legacy.sql.prepare('SELECT peremoga FROM polls WHERE message_id=1').get().peremoga,3);
  assert.equal(legacy.sql.prepare('SELECT count(*) n FROM polls').get().n,2);
  assert.deepEqual(legacy.sql.prepare('PRAGMA table_info(polls)').all(), new DB().sql.prepare('PRAGMA table_info(polls)').all());
});

test('digest reserve lasts through retries, releases on completion, and resets with the UTC day',()=>{
  const spent=[{ts:Date.parse('2026-11-01T17:00:00Z')/1000,neurons:7900}],off=7200;
  const before=Date.parse('2026-11-01T19:59:00Z'),during=Date.parse('2026-11-01T20:01:00Z');
  assert.equal(pipeline.repliesLeft(spent,before,off),0);assert.equal(pipeline.repliesLeft(spent,during,off),0);
  assert.ok(pipeline.repliesLeft(spent,during,off,false,['evening'])>0);
  assert.ok(pipeline.repliesLeft(spent,Date.parse('2026-11-02T00:01:00Z'),off)>0);
});

test('committee accounts all three successful responses',async()=>{
  const {db,env}=fixture();env.AI.run=async()=>completion('10');
  assert.equal((await worker.committee(env,'synthetic-base64')).score,10);
  assert.equal(db.sql.prepare('SELECT count(*) n FROM spend').get().n,3);
});

test('whole reply handles preflight DB failure and sends one fallback',async()=>{
  const {db,env,sent}=fixture();db.hooks.all=(q)=>{if(q.startsWith('SELECT name, text FROM messages'))throw Error('synthetic unavailable');};
  await worker.answer(env,{chat:{id:env.GROUP_CHAT_ID},message_id:1},'TesterA','@babtsya_z_altanky_bot привіт','');
  assert.equal(sent.filter(s=>s.method==='sendMessage').length,1);
});

test('hanging vision and alternate image attempt finish within their budgets',async()=>{
  const {env}=fixture();env.replyUntil=Date.now()+20;
  globalThis.fetch=async()=>new Promise(()=>{});
  assert.equal(await worker.look(env,'synthetic-photo'),'');
  let calls=0;const f=fixture();f.env.AI.run=async()=>{if(++calls===1)throw Error('3030');return new Promise(()=>{});};
  assert.equal(await worker.draw64(f.env,'scene','alternate',5),null);
});

test('image retries never start after the shared reply deadline', async () => {
  const { env } = fixture(); let clock = originalNow(), calls = 0;
  Date.now = () => clock; env.replyUntil = clock + 10;
  env.AI.run = async () => { calls++; clock += 11; throw Error('3030'); };
  assert.equal(await worker.draw64(env, 'scene', 'alternate', 100), null);
  assert.equal(calls, 1);
});

test('late getFile completion does not start a download after vision expires', async () => {
  const { env } = fixture(); let clock = originalNow(), requests = 0;
  Date.now = () => clock; env.replyUntil = clock + 10;
  globalThis.fetch = async () => {
    requests++;
    clock += 11;
    return Response.json({ ok: true, result: { file_path: 'synthetic.jpg' } });
  };
  assert.equal(await worker.look(env, 'synthetic-photo'), '');
  assert.equal(requests, 1);
});

test('permanently missing polls stop retrying without invented vote totals', async () => {
  const { db, env } = fixture(); await worker.poll(env);
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return Response.json({ ok: false, error_code: 400, description: 'Bad Request: message to stop not found' });
  };
  await worker.closePoll(env, '2099-01-01');
  await worker.closePoll(env, '2099-01-01');
  assert.equal(attempts, 1);
  const row = db.sql.prepare('SELECT * FROM polls').get();
  assert.equal(row.zrada, null); assert.equal(row.peremoga, null);
  assert.match(row.close_error, /message to stop not found/);
  assert.equal(await worker.pollText(env, row.day), '');
});

test('temporary poll errors remain retryable and do not block another poll', async () => {
  const { db, env } = fixture(); await worker.poll(env); await worker.poll(env);
  let attempts = 0;
  globalThis.fetch = async (_url, options) => {
    const { message_id } = JSON.parse(options.body); attempts++;
    return message_id === 1 && attempts === 1
      ? Response.json({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 1 } })
      : Response.json({ ok: true, result: { options: [{ text: 'Зрада', voter_count: 1 }, { text: 'Перемога', voter_count: 3 }] } });
  };
  await worker.closePoll(env, '2099-01-01');
  assert.equal(db.sql.prepare('SELECT zrada FROM polls WHERE message_id=1').get().zrada, null);
  assert.equal(db.sql.prepare('SELECT peremoga FROM polls WHERE message_id=2').get().peremoga, 3);
  await worker.closePoll(env, '2099-01-01');
  assert.equal(db.sql.prepare('SELECT peremoga FROM polls WHERE message_id=1').get().peremoga, 3);
  assert.equal(attempts, 3);
});

test('whole reply deadline sends one fallback, clears typing and suppresses late work', async () => {
  const { db, env, sent, calls } = fixture();
  let release;
  const gate = new Promise((ok) => { release = ok; });
  db.hooks.all = (query) => query.startsWith('SELECT name, text FROM messages') ? gate : undefined;
  env.replyUntil = Date.now() + 20;
  const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
  const active = new Set();
  globalThis.setInterval = (...args) => { const timer = realSet(...args); active.add(timer); return timer; };
  globalThis.clearInterval = (timer) => { active.delete(timer); realClear(timer); };
  try {
    await worker.answer(env, { chat: { id: env.GROUP_CHAT_ID }, message_id: 1 }, 'TesterA', '@babtsya_z_altanky_bot привіт', '');
    assert.equal(active.size, 0);
    assert.equal(sent.filter((s) => s.method === 'sendMessage').length, 1);
    release(); await new Promise((ok) => setTimeout(ok, 10));
    assert.equal(sent.filter((s) => s.method === 'sendMessage').length, 1);
    assert.equal(calls.length, 0);
  } finally {
    release(); for (const timer of active) realClear(timer);
    globalThis.setInterval = realSet; globalThis.clearInterval = realClear;
  }
});

test('truncated writing retries once and preserves input when both attempts fail', async () => {
  for (const recover of [false, true]) {
    const { db, env } = fixture(); seed(db);
    const run = env.AI.run; let writes = 0;
    env.AI.run = async (model, args) => {
      if (String(args.messages?.[0]?.content).startsWith('Ти — Бабця з альтанки, бот')) {
        writes++;
        return recover && writes === 2 ? completion(play) : { ...completion('«Обрив»'), choices: [{ finish_reason: 'length' }] };
      }
      return run(model, args);
    };
    await worker.digest(env, '2026-11-01', 'manual');
    assert.equal(writes, 2);
    assert.equal(db.sql.prepare('SELECT count(*) n FROM messages WHERE processed=0').get().n, recover ? 0 : 60);
  }
});

test('committee records measured usage and estimates each response without usage', async () => {
  for (const measured of [true, false]) {
    const { db, env } = fixture();
    env.AI.run = async () => measured ? completion('10') : { response: '10' };
    await worker.committee(env, 'synthetic-base64');
    const rows = db.sql.prepare('SELECT neurons FROM spend').all();
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => Number.isFinite(r.neurons) && r.neurons > 0));
    if (measured) assert.ok(rows.every((r) => Math.abs(r.neurons - 0.36364) < 1e-9));
  }
});

test('test-mode digest never exceeds the hard limit after its prefix is added', async () => {
  const { db, env, sent } = fixture(); seed(db); env.TEST_MODE = '1';
  const run = env.AI.run;
  env.AI.run = async (model, args) => String(args.messages?.[0]?.content).startsWith('Ти — Бабця з альтанки, бот')
    ? completion(play.replace('Лавку пофарбуємо до обіду.', 'Кава стигне.\n\n'.repeat(600))) : run(model, args);
  await worker.digest(env, '2026-11-01', 'manual');
  assert.ok(sent.every((s) => !s.body.text || s.body.text.length <= pipeline.HARD_LIMIT));
  assert.equal(db.sql.prepare('SELECT count(*) n FROM messages WHERE processed=0').get().n, 60);
  assert.equal(db.sql.prepare('SELECT count(*) n FROM digests').get().n, 0);
});

test('confirmed daily quota overrides estimates across requests and expires at UTC midnight', async () => {
  const { db, env } = fixture(); let clock = Date.parse('2026-11-01T12:00:00Z'), calls = 0;
  Date.now = () => clock;
  env.AI.run = async () => { calls++; throw Error('4006: you have used up your daily free allocation of 10,000 neurons'); };
  await worker.ai(env, 'system', 'question', 0.2, 100, 0);
  assert.equal(calls, 1);
  assert.equal(await worker.left(env), 0);
  await worker.ai({ ...env }, 'system', 'another question', 0.2, 100, 0);
  assert.equal(calls, 1);
  clock = Date.parse('2026-11-02T00:00:00Z');
  assert.ok(await worker.left(env) > 0);
  env.AI.run = async () => completion('Знову працюємо.');
  assert.equal(await worker.ai(env, 'system', 'question', 0.2), 'Знову працюємо.');
});

test('temporary capacity errors retry without marking the daily quota exhausted', async () => {
  const { env } = fixture(); let calls = 0;
  env.AI.run = async () => { if (++calls === 1) throw Error('3040: Capacity temporarily exceeded'); return completion('Відповідь.'); };
  assert.equal(await worker.ai(env, 'system', 'question', 0.2, 100, 0), 'Відповідь.');
  assert.equal(calls, 2); assert.ok(await worker.left(env) > 0);
});

test('image quota failure sets the counter to zero without trying another model', async () => {
  const { env } = fixture(); let calls = 0;
  env.AI.run = async () => { calls++; throw Error('3036: you have used up your daily free allocation of 10,000 neurons'); };
  assert.equal(await worker.draw64(env, 'scene'), null);
  assert.equal(calls, 1); assert.equal(await worker.left(env), 0);
});

test('quota fallback reports zero and does not invite another immediate attempt', async () => {
  const { env, sent } = fixture(); let calls = 0;
  env.AI.run = async () => { calls++; throw Error('4006: you have used up your daily free allocation of 10,000 neurons'); };
  for (const id of [1, 2]) await worker.answer(env, { chat: { id: env.GROUP_CHAT_ID }, message_id: id }, 'TesterA', '@babtsya_z_altanky_bot яка ковбаса?', '');
  const replies = sent.filter((s) => s.method === 'sendMessage');
  assert.equal(replies.length, 2); assert.equal(calls, 1);
  assert.ok(replies.every((s) => /\(0\)$/.test(s.body.text) && !/питай іще|повтори/i.test(s.body.text)));
});

test('usage from a late model response is recorded after the caller times out', async () => {
  const { db, env } = fixture(); let release;
  const gate = new Promise((ok) => { release = ok; });
  env.AI.run = async () => { await gate; return completion('Запізніла відповідь.'); };
  try {
    assert.equal(await worker.ai(env, 'system', 'question', 0.2, 100, 0, Date.now() + 10), '');
    release(); await new Promise((ok) => setImmediate(ok));
    assert.equal(db.sql.prepare('SELECT count(*) n FROM spend').get().n, 1);
  } finally { release(); }
});

test('morning and ordinary fallback grumbles rotate even when AI returns nothing', async () => {
  const random = Math.random; Math.random = () => 0;
  try {
    for (const section of ['ранок', 'загальне']) {
      const { env, sent } = fixture(); env.AI.run = async () => completion('');
      await worker.grumble(env, new Date(), section);
      await worker.grumble(env, new Date(), section);
      const texts = sent.filter((s) => s.method === 'sendMessage').map((s) => s.body.text);
      assert.equal(texts.length, 2); assert.notEqual(texts[0], texts[1]);
    }
  } finally { Math.random = random; }
});

test('the repeated to-yak-probuvaty frame loses to a direct answer', () => {
  const repeated = 'Колю, вибір між ковбасою й сиром — то як пробувати збудувати майбутнє: велична й марна справа.';
  const fresh = 'Ковбаса хоч мовчить, поки її ріжеш. Бери свіжу.';
  assert.deepEqual(pipeline.ticFree([repeated, fresh], 'яку ковбасу купити?'), [fresh]);
});

test('tag replies prefer a new opening over a recent one when both drafts are usable', async () => {
  const { db, env } = fixture(); let drafts = 0;
  db.sql.prepare('INSERT INTO said(ts,text) VALUES(?,?)').run(now(), 'Ковбаса мовчить, поки ти сперечаєшся з продавцем.');
  const fresh = 'Перевіряй склад, а не обіцянки на етикетці.';
  env.AI.run = async (_model, args) => {
    if (String(args.messages[0].content).startsWith('Ти — Бабця з альтанки, бурчлива')) return completion(++drafts === 2 ? fresh : 'Ковбаса мовчить, зате ціна кричить.');
    return completion(String(args.messages[1].content).includes('Варіанти:') ? '1 10' : 'НЕМАЄ');
  };
  const reply = await worker.compose(env, 'TesterA', '@babtsya_z_altanky_bot яку ковбасу купити?', '', 1.2);
  assert.equal(reply.text, fresh);
});

test('a quota failure during the first drawing request sends an offline reply with zero', async () => {
  const { env, sent } = fixture(); let calls = 0;
  env.AI.run = async () => { calls++; throw Error('4006: you have used up your daily free allocation of 10,000 neurons'); };
  await worker.answer(env, { chat: { id: env.GROUP_CHAT_ID }, message_id: 1 }, 'TesterA', '@babtsya_z_altanky_bot намалюй себе', '');
  assert.equal(calls, 1);
  const replies = sent.filter((s) => s.method === 'sendMessage');
  assert.equal(replies.length, 1); assert.match(replies[0].body.text, /\(0\)$/);
});
