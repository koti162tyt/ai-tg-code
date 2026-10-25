# ai-tg-code

Telegram-бот с ИИ на **Routeway**, развёрнутый на **Vercel** как serverless-вебхук.

Код лежит в GitHub; каждый коммит в основную ветку Vercel выкатывает сам.

## Как это устроено

```
Telegram  ──POST──▶  Vercel /api/webhook/<secret>  ──▶  Routeway API
                          │
                          └── ответ ──▶ Telegram sendMessage
```

Вебхук вместо long-polling выбран потому, что Vercel бесплатно даёт только
serverless-функции: процесс между запросами не живёт, а вебхук работает именно
так — Telegram сам дёргает функцию на каждое сообщение.

## Что нужно получить

| Что | Где | Примечание |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | [@BotFather](https://t.me/BotFather) → `/newbot` | строка вида `123456:AA...` |
| `TELEGRAM_WEBHOOK_SECRET` | придумать самому | случайные 24 байта hex |
| `ROUTEWAY_API_KEY` | [routeway.ai](https://routeway.ai) → Dashboard → API Keys | без карты |

Сгенерировать секрет:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

## Бесплатные модели Routeway

Модели с суффиксом `:free` стоят **ноль** и ограничены **5 запросами в минуту
и 200 в день** на аккаунт.

| Модель | Контекст | Замечание |
|---|---|---|
| `gemma-4-26b-a4b-it-chimerax:free` | 62 000 | **по умолчанию**, чистые ответы |
| `gemma-4-26b-a4b-it-luminous:free` | 62 000 | равноценная замена |
| `gemma-4-26b-a4b-it-darksoul:free` | 62 000 | вариант |
| `deepseek-v4-flash:free` | 42 000 | склонна к зацикливанию |
| `minimax-m2.7:free` | 42 000 | склонна к зацикливанию |

Выбрать другую: задать `LLM_MODEL` в переменных окружения.

⚠️ Модель **без** `:free` — платная и спишет деньги со счёта. Проверяйте суффикс.

## Локальный запуск

```bash
cp .env.example .env      # и заполнить три значения
npm run dev               # http://localhost:3000/api/webhook/<secret>
```

Для теста из Telegram нужен публичный HTTPS-адрес — например
`npx localtunnel --port 3000`, затем:

```bash
npm run set-webhook -- https://ваш-туннель.loca.lt
```

## Деплой на Vercel

1. Создать репозиторий на GitHub и добавить туда эти файлы.
2. [vercel.com/new](https://vercel.com/new) → Import Git Repository → выбрать репозиторий.
3. Framework Preset: **Other** (файла сборки нет, функции собираются из `api/`).
4. **Settings → Environment Variables** добавить:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_WEBHOOK_SECRET`
   - `ROUTEWAY_API_KEY`
   - по желанию: `LLM_MODEL`, `SYSTEM_PROMPT`
5. Deploy. Затем привязать вебхук:

```bash
npm run set-webhook -- https://ваш-проект.vercel.app
```

## Команды бота

| Команда | Действие |
|---|---|
| `/start` | приветствие и справка |
| `/reset` | забыть текущий разговор |
| `/status` | модель, размер истории, число чатов |

## Файлы

| Файл | Роль |
|---|---|
| `api/webhook.js` | весь HTTP-слой: приём update, ответ, ошибки |
| `lib/llm.js` | клиент Routeway (OpenAI-совместимый) |
| `lib/telegram.js` | Bot API: отправка, разбиение длинных ответов |
| `lib/memory.js` | история разговоров в памяти инстанса |
| `dev-server.js` | локальный сервер для отладки |
| `scripts/set-webhook.js` | привязка и удаление вебхука |

## Известные ограничения

- **История в памяти.** На serverless она теряется при холодном старте и не
  разделяется между параллельными инстансами. Для постоянной истории замените
  `lib/memory.js` на Vercel KV — интерфейс из четырёх функций сохранится.
- **Лимит 200 запросов в день.** Каждое сообщение — один запрос. При `429` бот
  отвечает сообщением об исчерпанной квоте до сброса в полночь UTC.
- **Секрет в URL.** Проверяется путь `/api/webhook/<secret>`; без совпадения
  запрос получает 404. Секрет не попадает в логи.

## Безопасность

`.env` в `.gitignore`. На Vercel значения задаются только через Environment
Variables. Токены в коде и в репозитории отсутствуют. Логи редактируются
(`redact()`), чтобы токен не попал в вывод.
