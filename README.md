# ai-tg-code

Telegram-бот с ИИ на **Routeway** плюс веб-консоль, развёрнутые на **Vercel**
как serverless-функции. Код лежит в GitHub; каждый коммит выкатывается сам.

## Две поверхности, одно ядро

```
Telegram  ──POST──▶  /api/webhook/<secret>  ─┐
                                            ├──▶ lib/llm.js ──▶ Routeway
Браузер   ──POST──▶  /api/chat  ──▶ lib/tools.js ──▶ GitHub (файлы)
Браузер   ──GET───▶  /api/status            ──▶ lib/stats.js + Telegram
Браузер   ──GET───▶  /api/files             ──▶ GitHub напрямую
```

Вебхук и консоль делят клиент модели, историю и словарь ошибок.

## Модель работает с файлами в GitHub

Браузерный чат умеет читать и писать файлы в репозитории. Модель **не трогает
GitHub напрямую**: она просит вызвать инструмент, сервер выполняет его и отдаёт
результат обратно.

| Инструмент | Что делает |
|---|---|
| `repo_list` | список файлов в папке |
| `repo_read` | прочитать текстовый файл |
| `repo_write` | создать или заменить файл (коммит) |
| `repo_delete` | удалить файл (коммит) |

**Границы, которые держит сервер, а не модель:**

- всё внутри `GITHUB_FOLDER` (по умолчанию `chat-files`);
- только текстовые расширения (`md`, `txt`, `json`, `py`, `js`, `yaml`, `csv`, …);
- пути с `..`, `.env` и скрытыми сегментами отклоняются;
- файл не больше 512 КБ;
- не больше 4 шагов инструментов за один ход.

Поэтому модель **не может** переписать код самого бота (`api/`, `lib/`) или
закоммитить бинарник.

## Что нужно получить

| Что | Где | Примечание |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | [@BotFather](https://t.me/BotFather) → `/newbot` | строка вида `123456:AA...` |
| `TELEGRAM_WEBHOOK_SECRET` | придумать | путь вебхука |
| `ADMIN_TOKEN` | придумать | пароль веб-консоли |
| `ROUTEWAY_API_KEY` | [routeway.ai](https://routeway.ai) → Dashboard | без карты |
| `GITHUB_TOKEN` | [fine-grained token](https://github.com/settings/personal-access-tokens/new) | **Contents: Read and write** на один репозиторий |
| `GITHUB_OWNER` / `GITHUB_REPO` | репозиторий | `koti162tyt` / `ai-tg-code` |
| `GITHUB_FOLDER` | придумать | по умолчанию `chat-files` |

⚠️ Не берите classic-токен со scope `repo`: он даёт запись **во все** ваши
репозитории. Нужен fine-grained на один.

Сгенерировать секреты:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

## Веб-консоль

Открыть `https://<проект>.vercel.app/`, вставить `ADMIN_TOKEN` в поле справа.

| Блок | Что делает |
|---|---|
| **Чат** | разговор с моделью в браузере; Enter — отправить |
| **Доступ** | поле `ADMIN_TOKEN`, кнопка подключения |
| **Статус** | счётчики, флаги ключей, состояние вебхука Telegram |
| **Промпт** | системный промпт для этого браузера |

Токен хранится в `localStorage` браузера, на сервер уходит только заголовком
`x-admin-token`.

**Ограничение:** счётчики в панели описывают **один тёплый инстанс**, а не весь
деплой — на serverless экземпляры не разделяют память. Долговечные счётчики
потребовали бы Vercel KV.

## Telegram-бот

Команды: `/start`, `/reset`, `/status`. Обычный текст — ответ модели.

## Бесплатные модели Routeway

Суффикс `:free` означает ноль. Лимит — **5 запросов в минуту, 200 в день**.

| Модель | Контекст | Замечание |
|---|---|---|
| `gemma-4-26b-a4b-it-chimerax:free` | 62 000 | по умолчанию |
| `gemma-4-26b-a4b-it-luminous:free` | 62 000 | равноценная замена |
| `deepseek-v4-flash:free` | 42 000 | зацикливается |
| `minimax-m2.7:free` | 42 000 | зацикливается |

⚠️ Модель **без** `:free` — платная.

## Локальный запуск

```bash
cp .env.example .env      # заполнить ключи
npm run dev               # http://localhost:3000/
```

Сервер обслуживает консоль на `/`, вебхук на `/api/webhook/<secret>` и API
консоли. Достаточно `ADMIN_TOKEN` (для консоли) **или** `TELEGRAM_WEBHOOK_SECRET`
(для бота) — требовать оба сразу не нужно.

Привязка вебхука к туннелю:

```bash
npx localtunnel --port 3000
npm run set-webhook -- https://ваш-туннель.loca.lt
```

## Деплой на Vercel

1. Добавить файлы в репозиторий GitHub.
2. [vercel.com/new](https://vercel.com/new) → Import → выбрать репозиторий.
3. Application Preset: **Other**.
4. Environment Variables: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
   `ADMIN_TOKEN`, `ROUTEWAY_API_KEY`.
5. Deploy, затем привязать вебхук:

```bash
npm run set-webhook -- https://ваш-проект.vercel.app
```

## Файлы

| Файл | Роль |
|---|---|
| `api/webhook.js` | Telegram webhook |
| `api/chat.js` | один ход чата из браузера, с циклом инструментов |
| `api/status.js` | данные админ-панели |
| `api/files.js` | прямой доступ к файлам: list/read/write/delete |
| `lib/llm.js` | клиент Routeway (`chat` и `chatRaw` для инструментов) |
| `lib/tools.js` | инструменты модели и их выполнение |
| `lib/github.js` | GitHub Contents API + защита путей |
| `lib/telegram.js` | Bot API, разбиение длинных ответов |
| `lib/memory.js` | история разговоров в памяти инстанса |
| `lib/http.js` | токен-проверка (constant-time), JSON-разбор |
| `lib/stats.js` | счётчики и снимок конфигурации |
| `public/index.html` | веб-консоль (без сборки) |
| `dev-server.js` | локальный сервер |
| `scripts/set-webhook.js` | привязка вебхука |

## Безопасность

- `.env` в `.gitignore`; на Vercel значения только в Environment Variables.
- `ADMIN_TOKEN` сравнивается в constant-time и никогда не возвращается в ответах.
- Вебхук требует секрет в пути; несовпадение — `404`.
- Логи редактируются (`redact()`), токены не попадают в вывод.

## Известные ограничения

- **История и счётчики в памяти** — теряются при cold start, не разделяются между
  инстансами. Замена на Vercel KV не меняет интерфейс `lib/memory.js`.
- **Лимит 200 запросов в день** общий на модель: каждое сообщение — один запрос.
- **`maxDuration: 60s`** — медленный ответ упрётся в этот предел.
