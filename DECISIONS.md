# DECISIONS

Judgement calls made while building جدولي, so any of them can be revisited.

## Data & logic

1. **Profile definitions live in `data/schedule.json`** (`profiles.carrier` = محمد, masculine, drops `control`, adds Heat 1; `profiles.standard` = خلود, feminine). This keeps names and rules in one source of truth for both the app and the reminder.
2. **`campusDay`** (`08:30–14:30`) is added to the JSON for reference. The "سوه" comparison window is computed from the shifts in use: morning → 08:30–14:30, evening → 14:30–19:30, mixed → 08:30–19:30.
3. **Clash = overlapping sessions inside one profile.** Overlaps are merged into one entry. The clash id is `day@HH:MM` of the block start (e.g. `sun@08:30`), so a "رايح لهاي" choice repeats every week for that day and slot.
4. **An undecided clash counts as busy for both sides** (for "now", next session and free-time maths). A decided clash counts only the chosen session; the other stays visible but dimmed.
5. **Lab group "ما أعرف بعد"** shows both Thursday Heat 1 labs, tagged "حسب كروبك", and they create clashes (as acceptance check 5 requires). "الاثنين" shows both without the uncertainty tag. A or B keeps only that lab.
6. **Day summary counts time blocks, not sessions**: a clash is one block, so Sunday reads "3 محاضرات · تصادم واحد".
7. **Smart default view**: before the last active session of today ends → the "هسه" tab. Otherwise → the "باجر" tab, which shows the weekend card plus the next working day when tomorrow is Friday/Saturday or a manual holiday.
8. **Week tab** shows the current Sunday–Thursday week. On Friday and Saturday it shows the coming week.
9. **Next-session search** looks ahead 21 days, so a run of manual holidays can't hide the next class.
10. **"Shared sessions" in سوه** = same stream, day, start time, subject and kind, attended by both people.

## The other person's settings

11. Each user's CloudStorage is private to them, so the app cannot read the partner's real settings. For "سوه" and the "شوف جدول …" peek, the app uses a **local copy of the partner's settings** (shift, and for محمد the Heat 1 track). It defaults to morning and can be edited in Settings → "جدول [الاسم]". The peek view is read-only (no clash choices, no overrides).

## Storage

12. CloudStorage values are capped at 4096 characters, so state is split across keys: `profile`, `settings`, `clash`, `overrides`, `partner`, `theme`. Overrides older than 21 days are pruned automatically.
13. localStorage is always written too (as an instant-load mirror). Inside Telegram, CloudStorage is read after first paint and wins if it differs. On the first Telegram run with local-only data, local data is pushed up to the cloud.

## UI

14. **Bottom navigation has 5 tabs at most** (هسه، باجر، الأسبوع، هيت 1، سوه). Settings opens from a gear button in the header as a sub-view with Telegram's `BackButton`. خلود sees 4 tabs, because the Heat 1 tab is carrier-only.
15. **Icons are inline SVG** (one stroke family), not emoji. Emoji appear only in shared text and the reminder message.
16. **Times**: 12-hour with a small ص/م, rendered so they read naturally in RTL ("من 8:30 ص لـ 2:30 م"). Countdowns over 24h show total hours (e.g. `69:09:47`) plus an Arabic line ("بعد يومين و21 ساعة").
17. **Theme**: follows Telegram's `colorScheme` (or the OS outside Telegram). A manual override (تلقائي/فاتح/غامق) is available in Settings.
18. **Testing hooks**: `?now=YYYY-MM-DDTHH:MM` (Baghdad time) mocks the clock, `?theme=dark|light` forces a theme, `?profile=carrier|standard` forces a profile. They only affect the viewer's own browser.
19. **"شارك"** shares text through `https://t.me/share/url` with the bot link (`https://t.me/ShnoBajer_bot`) as the required `url` parameter.
20. The design-system search tool from the UI skill needs Python, which isn't installed on this machine. The design follows the skill's built-in rules and checklist instead (contrast, 44px targets, safe areas, reduced motion, token-based themes).

## Reminder

21. **Cron `7 18 * * 6,0,1,2,3`** = 21:07 Baghdad on Sat–Wed (UTC day = Baghdad day at that hour).
22. Clash choices live in each user's CloudStorage, which the Bot API can't read, so **the reminder shows clashes as warnings** and links to the app to choose.
23. **Keepalive**: every run calls `PUT /actions/workflows/reminder.yml/enable` with the workflow's own `GITHUB_TOKEN` (`actions: write`). This resets GitHub's 60-day inactivity timer without empty commits.
24. If `BOT_TOKEN` or `RECIPIENTS` is missing, the script prints one line and exits 0. It never prints the token or chat IDs, only recipient indexes.
25. A `tests.yml` workflow runs `node --test` plus a reminder dry run on every push.

## Round 2 (photos, sync, notifications)

30. **Photos** are cropped to 360px squares in `assets/` and shown in a hexagon (benzene) frame with a rotating gradient ring: on the picker, in the header and on سوه.
31. **Greeting is addressed to the account owner** with gender agreement (صباحك/صباحچ خير، مساك/مساچ خير، هلا بيك/بيچ). It uses the profile name, not the Telegram name.
32. **The evening Heat 1 tip and the track switch were removed from the Heat 1 tab** (محمد works after college). The track is still available in Settings.
33. **Shared sync without a server.** The Mini App sends a single payload (`Telegram.WebApp.sendData`, max 4096 bytes: profile, prefs, clash choices, pending edits) to the bot. This only works when the app is opened from the bot's **keyboard button**, which the bot sends on /start. `bot/run.mjs` runs on GitHub Actions every 5 min (07:00–22:55 Baghdad). It applies the payload, then commits:
    - `shared.json` (public: timetable edits + non-personal prefs), which both apps read from `raw.githubusercontent.com/.../state/shared.json`.
    - `bot.enc` (AES-256-GCM, key derived from BOT_TOKEN: chat ids, prefs, offset, sent log).

    Both live on a separate `state` branch, so they never trigger Pages or test runs.
34. **Edits are operations** (`add` / `remove` / `update` / `revert`) applied after the department amendments. An `update` keeps the session key, so clash choices and per-date overrides survive. Edits show locally right away (outbox) and drop out of the outbox once the bot has applied them.
35. **Identity**: the first chat to sync a profile claims it. Others are refused, so strangers who /start the bot can't edit the timetable.
36. **Notifications**: default 8 PM summary of tomorrow + 15 min before each session (both configurable). The job sleeps up to 4 min to hit the exact time, dedupes through the sent log, and skips a lecture reminder once the lecture has started. GitHub cron can be a few minutes late; this is documented.
37. The `RECIPIENTS` secret and the old nightly workflow were removed. The bot learns chat ids from the sync itself.

## Repo & security

26. `.env` and `PROMPT.md` are in `.gitignore` from the first commit. `.githooks/pre-commit` scans staged files and `.githooks/pre-push` scans every pushed commit (files and message) for the token read from `.env`; either one aborts. The hooks are enabled with `git config core.hooksPath .githooks`.
27. Git authorship uses the GitHub **noreply** email, so a personal email never appears in the public repo.
28. GitHub Pages is served from `main` / root (no build step). `.nojekyll` makes Pages serve files as-is.
29. The local dev server (`scripts/serve.mjs`) refuses to serve `.env`, `.git` and `PROMPT.md`.
