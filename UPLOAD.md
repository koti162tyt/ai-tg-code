# Как загрузить ai-tg-code в GitHub через браузер

Репозиторий: https://github.com/koti162tyt/ai-tg-code

## Порядок

GitHub не умеет загружать папки с сохранением структуры через веб-интерфейс
кнопкой «Add file», поэтому файлы в подпапках (`api/`, `lib/`, `scripts/`)
добавляются с указанием полного пути в имени — GitHub сам создаст папки.

### Шаг 1. Корневые файлы

На странице репозитория: **Add file → Upload files** → перетащите эти 4 файла
из папки `F:\душнило\мктп\ai-tg-code\`:

- `.gitignore`
- `package.json`
- `vercel.json`
- `README.md`

⚠️ `.env.example` тоже корневой — добавьте его сюда же.

Нажмите **Commit changes**.

### Шаг 2. Папка api

**Add file → Create new file**. В поле имени введите:

```
api/webhook.js
```

Слэш создаст папку `api`. Вставьте содержимое из
`F:\душнило\мктп\ai-tg-code\api\webhook.js`.

**Commit changes**.

### Шаг 3. Папка lib (3 файла)

Тем же способом, каждый отдельно:

```
lib/modelscope.js
lib/telegram.js
lib/memory.js
```

### Шаг 4. Папка scripts

```
scripts/set-webhook.js
```

### Шаг 5. dev-server.js

Корневой файл, через **Add file → Create new file** с именем `dev-server.js`.

## Проверка

После всех шагов в репозитории должна быть такая структура:

```
ai-tg-code/
├── .env.example
├── .gitignore
├── README.md
├── dev-server.js
├── package.json
├── vercel.json
├── api/
│   └── webhook.js
├── lib/
│   ├── memory.js
│   ├── modelscope.js
│   └── telegram.js
└── scripts/
    └── set-webhook.js
```

Всего 11 файлов.

## Что НЕ загружать

- `.env` — его нет в папке, и создавать не нужно на этом этапе;
- `node_modules` — его тоже нет.

## После загрузки

Vercel берёт код из репозитория. Ключи задаются **не в коде**, а в
**Vercel → Settings → Environment Variables**:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `MODELSCOPE_API_KEY`
