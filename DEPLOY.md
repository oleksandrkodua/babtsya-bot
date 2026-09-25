# Бабця з альтанки — встановлення й підключення

План від нуля до працюючого бота в групі. **[ти]** — робиш ти (твої акаунти, токени, група), **[я]** — роблю я (код і конфіг).

Після запуску бот працює на Cloudflare сам: твій Mac і Claude для роботи не потрібні, лише для змін.


---

## Етап 1. Підготовка — можна зараз

1. **[ти] BotFather** (`@BotFather` → твій бот → Bot Settings):
   - Allow Groups — **увімкнено**;
   - Group Privacy — **вимкнено** (інакше бот бачить лише команди);
   - права адміна — не потрібні.
2. **[ти] Група:** якщо бота вже додано, видали його й додай знову — зміна Group Privacy діє лише після повторного додавання. Перевір у налаштуваннях групи, що учасникам дозволено надсилати опитування (для «зради чи перемоги»).
3. **[ти] Згода:** напиши в групі, що бот читатиме чат і що текст обробляє AI-модель Cloudflare. Ще одне варто сказати: бот не бачить видалень — видалене повідомлення все одно може потрапити у вижимку.
4. **[ти] Cloudflare:** акаунт уже є. Node.js на Mac уже є (v26).

## Етап 2. Ідентифікатори чатів — можна зараз

Потрібні два числа: id групи й id твого особистого чату з ботом (для тестового режиму). Діє тільки **до** встановлення webhook — потім `getUpdates` перестає працювати.

1. **[ти]** Напиши будь-що в групі, а потім боту в особисті.
2. **[ти]** У Terminal (токен бота не залишиться в історії):
   ```bash
   read -r -s -p "Токен бота: " BOT && echo && curl -s "https://api.telegram.org/bot$BOT/getUpdates" | python3 -c "import json,sys; [print(u['message']['chat']['type'], u['message']['chat']['id'], u['message']['chat'].get('title') or u['message']['chat'].get('first_name')) for u in json.load(sys.stdin)['result'] if 'message' in u]"
   ```
3. **[ти]** Запиши два числа: `supergroup -100…` — це `GROUP_CHAT_ID`, `private …` — це `TEST_CHAT_ID`. Вони не секретні, їх можна скинути мені.

## Етап 3. Код — готово

**[я]** Уже в теці:
- `wrangler.toml` — конфіг: база D1, Workers AI, запуск кожні пів години `0,30 * * * *`, змінні `GROUP_CHAT_ID` (зараз — тестова група), `TEST_CHAT_ID`, `TEST_MODE = "1"`;
- `schema.sql` — таблиці `messages`, `digests`, `people`, `polls`, `pics`, `usage`. Оновлюєш існуючу базу з версії до 25.09 — один раз виконай `npx wrangler d1 execute babtsya --remote --command "ALTER TABLE pics ADD COLUMN data TEXT"`, потім `schema.sql` (він створює лише відсутні таблиці);
- `src/pipeline.js` — уся обробка тексту: фільтри, редакція, коректор, довжина. Перевіряється без Cloudflare: `node src/pipeline.js`;
- `src/index.js` — webhook, розклад, модель, відправка. Промпти бере з тих самих `prompts/`, що й тестовий стенд.

Опитування «зрада чи перемога» підключене: о 21:00 надсилається, о 22:00 закривається (логіка в `poll.js`).

## Етап 4. Розгортання — можна зараз

Усе в Terminal, у теці проєкту: `cd ~/Desktop/атббот`. Глобально нічого не встановлюється — `npx` бере `wrangler` сам.

1. **[ти] Вхід у Cloudflare** (відкриє браузер):
   ```bash
   npx wrangler login
   ```
2. **[ти] База:**
   ```bash
   npx wrangler d1 create babtsya
   ```
   Скинь мені `database_id` з виводу — **[я]** впишу його в `wrangler.toml`. Потім:
   ```bash
   npx wrangler d1 execute babtsya --remote --file=schema.sql
   ```
3. **[ти] Секрети** — кожна команда попросить значення, у файли й історію воно не потрапляє:
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put WEBHOOK_SECRET
   ```
   `WEBHOOK_SECRET` — довільний рядок з латиниці й цифр, 20+ символів. Він не дає стороннім підсовувати боту фальшиві повідомлення.
4. **[ти] Викладання:**
   ```bash
   npx wrangler deploy
   ```
   У виводі буде адреса на кшталт `https://babtsya-bot.<your-subdomain>.workers.dev`.
5. **[ти] Webhook** — з цієї миті Telegram шле повідомлення групи в Worker:
   ```bash
   read -r -s -p "Токен бота: " BOT && echo && read -r -s -p "WEBHOOK_SECRET: " SEC && echo && curl -s "https://api.telegram.org/bot$BOT/setWebhook" -H "Content-Type: application/json" -d "{\"url\":\"https://babtsya-bot.<your-subdomain>.workers.dev/telegram\",\"secret_token\":\"$SEC\",\"allowed_updates\":[\"message\",\"edited_message\"]}"
   ```
   Відповідь має бути `"ok":true`. Перевірка: `curl -s "https://api.telegram.org/bot$BOT/getWebhookInfo"`.

## Етап 5. Тестовий режим — кілька днів

`TEST_MODE=1` (за замовчуванням): бот читає групу, але вижимки й опитування надсилає **тобі в особисті**, а не в групу.

- **[ти]** Не чекати 22:00 — запустити вижимку вручну (прийде тобі в особисті). Увага: оброблені повідомлення після цього видаляються з бази, як і після звичайного випуску.
  ```bash
  read -r -s -p "WEBHOOK_SECRET: " SEC && echo && curl -s -X POST -H "X-Telegram-Bot-Api-Secret-Token: $SEC" "https://babtsya-bot.<your-subdomain>.workers.dev/run?kind=manual"
  ```
- **[ти]** Живі логи Worker'а:
  ```bash
  npx wrangler tail
  ```
- **[ти + я]** Щодня дивимось вижимку в особистих. Якщо щось не так — я правлю промпти чи код, ти робиш `npx wrangler deploy`.
- Нейрони — Cloudflare → Workers AI → Daily usage. Орієнтир: ~150–250 на звичайний випуск, до ~1–1,5 тис. на обидва випуски великого дня.

## Етап 6. Запуск у групу

1. **[ти]** Додай бота в основну групу, запусти `npx wrangler tail` і напиши в групі будь-що. У логах з'явиться рядок `Чужий чат: -100… supergroup Назва` — скинь мені це число. (Команда з етапу 2 тут не спрацює: після webhook `getUpdates` вимкнено.)
2. **[я]** Вписую його в `GROUP_CHAT_ID` і ставлю `TEST_MODE = "0"` у `wrangler.toml`.
3. **[ти]** `npx wrangler deploy`. Webhook чіпати не треба — адреса та сама.
4. Перший вечірній випуск о 22:00, обідній о 13:00 — кожен, якщо з попереднього випуску набралось ≥ 50 повідомлень, інакше вони переходять у наступний випуск.

Опитування «зрада чи перемога» щодня о 21:00 іде разом з рештою розкладу.

## Прибирання

- **[ти]** Якщо токен бота колись опиниться не там, де треба: перевипусти його в BotFather (`/revoke`) і онови секрет `npx wrangler secret put TELEGRAM_BOT_TOKEN`.

## Як вимкнути

- Тимчасово зупинити вижимки — зняти webhook:
  ```bash
  read -r -s -p "Токен бота: " BOT && echo && curl -s "https://api.telegram.org/bot$BOT/deleteWebhook"
  ```
  Бот перестане отримувати повідомлення, тож вижимок не буде. Опитування, якщо вони увімкнені, розклад публікуватиме й далі — щоб зупинити все, видали Worker (нижче).
- Повністю: `npx wrangler delete` (Worker) і `npx wrangler d1 delete babtsya` (база з усіма збереженими повідомленнями), потім видалити бота з групи.
