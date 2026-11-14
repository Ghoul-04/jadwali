# جدولي · Shno Bajer

A Telegram Mini App timetable for two 4th-year Chemical Engineering students (University of Basrah, 1st semester 2026–2027). It's designed as "the periodic table of my week".

- **Bot:** [@ShnoBajer_bot](https://t.me/ShnoBajer_bot). Open it and press the **📅 جدولي** menu button.
- **No server:** a static site on GitHub Pages (vanilla ES modules, no build step). Per-user state is kept in Telegram CloudStorage, with localStorage as a fallback.
- **Nightly reminder:** GitHub Actions cron (`.github/workflows/reminder.yml`).

```
index.html            app shell
styles/app.css        design system + screens (light/dark)
core/schedule.js      pure schedule logic (browser + Node)
app/                  UI modules, telegram.js, storage.js
data/schedule.json    single source of truth (printed timetable + amendments)
reminder/send.mjs     nightly message
tests/                node --test acceptance checks (mocked clock)
scripts/              local dev server, bot setup, .env reader
```

```bash
node --test                 # run the tests
node scripts/serve.mjs      # http://localhost:5173  (?now=2026-11-16T09:00&theme=dark)
```

Setup guide (Arabic): [SETUP_AR.md](SETUP_AR.md) · Design and logic decisions: [DECISIONS.md](DECISIONS.md)
