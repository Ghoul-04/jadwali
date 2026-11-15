// core/exams.js — pure exam logic (midterms). Browser + Node, no dependencies.
import { zonedNow, zonedEpoch, addDays, dayKeyOf, toMin, time12Str, DAY_NAMES } from './schedule.js';

/** Minutes after the start when a timed exam counts as over. */
export const EXAM_LENGTH = 120;
/** An exam with an unannounced time counts as over at the end of the campus day (never shown as a time). */
export const UNKNOWN_DONE_AT = 14 * 60 + 30;

export function partnerOf(data, profileId) {
  return Object.keys(data.profiles).find((p) => p !== profileId);
}

/** A profile takes a subject unless it dropped it; Heat 1 only for profiles that carry it. */
export function takesSubject(data, profileId, subject) {
  const p = data.profiles[profileId];
  if (!p || !data.subjects[subject]) return false;
  if ((p.dropSubjects || []).includes(subject)) return false;
  if (subject === 'heat1') return !!p.addHeat1;
  return true;
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

export function examsFor(data, profileId) {
  return (data.exams || [])
    .filter((e) => e && e.date && takesSubject(data, profileId, e.subject))
    .map((e) => ({ ...e, start: e.time ? toMin(e.time) : null, dayKey: dayKeyOf(e.date) }))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? 0) - (b.start ?? 0));
}

export function examsOn(data, profileId, dateStr) {
  return examsFor(data, profileId).filter((e) => e.date === dateStr);
}

export function examDoneAt(data, e) {
  return zonedEpoch(e.date, e.start != null ? e.start + EXAM_LENGTH : UNKNOWN_DONE_AT, data.timezone);
}

/**
 * All of a profile's exams with their state at `now`, plus the next one and the free study days between exams.
 * season = there is still an exam to come; allDone = every exam is over.
 */
export function examTimeline(data, profileId, now = new Date()) {
  const z = zonedNow(now, data.timezone);
  const t = now.getTime();
  const list = examsFor(data, profileId).map((e) => ({
    ...e,
    done: t >= examDoneAt(data, e),
    dayDiff: daysBetween(z.dateStr, e.date),
    startsAt: e.start != null ? zonedEpoch(e.date, e.start, data.timezone) : null,
  }));
  const next = list.find((e) => !e.done) || null;
  const gaps = list.slice(1).map((e, i) => {
    const prev = list[i];
    const days = Math.max(0, daysBetween(prev.date, e.date) - 1);
    const dates = Array.from({ length: days }, (_, k) => addDays(prev.date, k + 1));
    return { after: prev.id, before: e.id, days, dates, left: dates.filter((d) => d >= z.dateStr).length };
  });
  return { today: z.dateStr, list, next, gaps, season: !!next, allDone: list.length > 0 && !next };
}

/** Show the one-time "خلصت المد" celebration? */
export function celebrationDue(tl, alreadyCelebrated) {
  return tl.allDone && !alreadyCelebrated;
}

/** "ركّز اليوم على…": only on days without an exam of your own; suggests the nearest upcoming exam. */
export function focusSuggestion(data, profileId, now = new Date()) {
  const tl = examTimeline(data, profileId, now);
  if (!tl.next || tl.list.some((e) => e.date === tl.today)) return null;
  return { exam: tl.next, days: tl.next.dayDiff };
}

// ───────── words ─────────

/** Nickname without the leading "ال" so it reads naturally after "امتحان": امتحان سيطرة. */
export function examNick(data, subject) {
  return String(data.subjects[subject]?.nick || subject).replace(/^ال/, '');
}

export function examTimeText(e) {
  return e.start != null ? time12Str(e.start) : 'الوقت ما متبلغ بعد';
}

export function dayWord(diff, dayKey) {
  if (diff === 0) return 'اليوم';
  if (diff === 1) return 'باجر';
  if (diff === 2) return 'عكب باجر';
  return DAY_NAMES[dayKey];
}

/** "بعد 3 أيام" style countdown in days (never invents an hour). */
export function daysLeftText(diff) {
  if (diff <= 0) return 'اليوم';
  if (diff === 1) return 'باجر';
  if (diff === 2) return 'بعد يومين';
  if (diff <= 10) return `بعد ${diff} أيام`;
  return `بعد ${diff} يوم`;
}

const LUCK = {
  m: ['بالتوفيق، أنت قدها 💪', 'نام زين، المخ يحتاج راحة قبل الامتحان', 'راجع العناوين بس، الباقي بمخك', 'خلّي الموبايل على جنب وريّح عيونك', 'ثقتك بنفسك نص الدرجة', 'اقرا السؤال مرتين قبل لا تجاوب'],
  f: ['بالتوفيق، أنتِ قدها 💪', 'نامي زين، المخ يحتاج راحة قبل الامتحان', 'راجعي العناوين بس، الباقي بمخچ', 'خلّي الموبايل على جنب وريّحي عيونچ', 'ثقتچ بنفسچ نص الدرجة', 'اقري السؤال مرتين قبل لا تجاوبين'],
};

/** Good-luck line that rotates by date + exam, so it doesn't repeat every time. */
export function luckLine(gender, seed) {
  const list = LUCK[gender === 'f' ? 'f' : 'm'];
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return list[h % list.length];
}

export function todayExamLine(data, e, gender) {
  return `اليوم امتحان ${data.subjects[e.subject].name}. بالتوفيق، ${gender === 'f' ? 'أنتِ' : 'أنت'} قدها`;
}

export function tomorrowExamLine(data, e) {
  return `باجر امتحان ${examNick(data, e.subject)} ${e.start != null ? time12Str(e.start) : '(الوقت ما متبلغ بعد)'}`;
}

export function partnerExamLine(data, partnerId, e, diff) {
  const p = data.profiles[partnerId];
  const has = p.gender === 'f' ? 'عدها' : 'عنده';
  const when = `${dayWord(diff, e.dayKey)}${diff >= 2 ? ` ${Number(e.date.slice(8))}/${Number(e.date.slice(5, 7))}` : ''}`;
  return `${p.name} ${has} امتحان ${examNick(data, e.subject)} ${when}${e.start != null ? ` ${time12Str(e.start)}` : ''} ${p.emoji || ''}`.trim();
}

/**
 * In-app reminder lines for today/tomorrow (replaces the Telegram messages):
 *  - your exam today (warm) / tomorrow (opens the list + a good-luck line)
 *  - the partner's exam today/tomorrow (with their fruit emoji), or a note that you share it
 */
export function examBrief(data, profileId, now = new Date()) {
  const z = zonedNow(now, data.timezone);
  const tmr = addDays(z.dateStr, 1);
  const me = data.profiles[profileId];
  const partnerId = partnerOf(data, profileId);
  const partner = data.profiles[partnerId];
  const mineToday = examsOn(data, profileId, z.dateStr).filter((e) => now.getTime() < examDoneAt(data, e));
  const mineTomorrow = examsOn(data, profileId, tmr);
  const lines = [];
  for (const e of mineToday) lines.push({ kind: 'today', exam: e, text: todayExamLine(data, e, me.gender) });
  for (const e of mineTomorrow) lines.push({ kind: 'tomorrow', exam: e, text: tomorrowExamLine(data, e), luck: luckLine(me.gender, `${tmr}|${e.id}`) });
  const mineIds = new Set([...mineToday, ...mineTomorrow].map((e) => e.id));
  for (const e of examsFor(data, partnerId)) {
    const diff = daysBetween(z.dateStr, e.date);
    if (diff < 0 || diff > 1 || (diff === 0 && now.getTime() >= examDoneAt(data, e))) continue;
    const text = mineIds.has(e.id)
      ? `${partner.name} ${me.gender === 'f' ? 'وياچ' : 'وياك'} بنفس الامتحان ${partner.emoji || ''}`.trim()
      : partnerExamLine(data, partnerId, e, diff);
    lines.push({ kind: 'partner', exam: e, text, shared: mineIds.has(e.id) });
  }
  return { today: z.dateStr, tomorrow: tmr, lines, mineToday, mineTomorrow };
}
