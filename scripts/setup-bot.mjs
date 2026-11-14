// One-off bot configuration through the Bot API. Reads BOT_TOKEN from .env; never prints it.
// Usage: node scripts/setup-bot.mjs https://<user>.github.io/<repo>/
import { tg } from './env.mjs';

const url = process.argv[2];
if (!url || !url.startsWith('https://')) {
  console.error('Usage: node scripts/setup-bot.mjs <https Mini App URL>');
  process.exit(1);
}

const description =
  'هلا 👋 هذا «شنو باجر» — جدول المرحلة الرابعة، قسم الهندسة الكيمياوية، جامعة البصرة.\n\n' +
  'دوس Start، وبعدين اضغط زر «📅 جدولي» اللي يم مربع الكتابة، وتشوف شنو عندك هسه، باجر، والأسبوع كله، ووكت الهيت، ووكت فراغكم سوه.';
const shortDescription = 'جدولك بالكلية: هسه، باجر، والأسبوع. اضغط زر «📅 جدولي» 👇';

const me = await tg('getMe');
console.log(`bot: @${me.username}`);

await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: '📅 جدولي', web_app: { url } } });
await tg('setMyDescription', { description });
await tg('setMyShortDescription', { short_description: shortDescription });
await tg('setMyCommands', { commands: [] });

const menu = await tg('getChatMenuButton', {});
const desc = await tg('getMyDescription', {});
const short = await tg('getMyShortDescription', {});
const cmds = await tg('getMyCommands', {});

const checks = [
  ['menu button', menu.type === 'web_app' && menu.text === '📅 جدولي' && menu.web_app?.url === url, JSON.stringify(menu)],
  ['description', desc.description === description, `${desc.description.length} chars`],
  ['short description', short.short_description === shortDescription, short.short_description],
  ['commands', Array.isArray(cmds) && cmds.length === 0, JSON.stringify(cmds)],
];
for (const [name, ok, detail] of checks) console.log(`${ok ? '✔' : '✖'} ${name}: ${detail}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
