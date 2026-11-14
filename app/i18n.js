// app/i18n.js — Iraqi Arabic copy with gender/person agreement.
import { DAY_NAMES, dayKeyOf } from '../core/schedule.js';

export const MONTHS = ['كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران', 'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'];

export function dateLabel(dateStr, { withDay = true } = {}) {
  const [, m, d] = dateStr.split('-').map(Number);
  const s = `${d} ${MONTHS[m - 1]}`;
  return withDay ? `${DAY_NAMES[dayKeyOf(dateStr)]} ${s}` : s;
}

/**
 * Copy for a "voice": who we're talking about.
 *   g: 'm' | 'f'   p: 2 (talking to the user) | 3 (peeking at the other person)
 */
export function voice({ g, p, name }) {
  const M = g === 'm';
  const second = p === 2;
  const have = second ? (M ? 'عندك' : 'عندچ') : (M ? 'عنده' : 'عندها');
  const free = M ? 'فاضي' : 'فاضية';
  const subj = second ? (M ? 'إنت' : 'إنتِ') : name;
  return {
    have,
    free,
    whatNow: `شنو ${have} هسه؟`,
    whatTomorrow: `شنو ${have} باجر؟`,
    nowHave: `هسه ${have}`,
    youFree: `${subj} ${free} هسه`,
    nextLabel: second ? 'الجاية' : 'الجاية',
    going: M ? 'رايح لهاي' : 'رايحة لهاي',
    rest: second ? (M ? 'ارتاح وانطي لنفسك وكت' : 'ارتاحي وانطي لنفسچ وكت') : (M ? 'خلي يرتاح' : 'خليها ترتاح'),
    noClass: `ماكو دوام ${second ? (M ? 'عندك' : 'عندچ') : (M ? 'عنده' : 'عندها')}`,
    doneToday: second ? (M ? 'خلصت دوامك اليوم' : 'خلصتي دوامچ اليوم') : (M ? 'خلص دوامه اليوم' : 'خلصت دوامها اليوم'),
    weekendTitle: 'باجر عطلة',
    weekendSub: second ? (M ? 'نام زين، الدوام يرجع' : 'نامي زين، الدوام يرجع') : 'الدوام يرجع',
    yours: second ? (M ? 'مالتك' : 'مالتچ') : (M ? 'ماله' : 'مالها'),
  };
}

/** Greeting addressed to the account owner, with gender agreement. */
export function greetingFor(minutes, g) {
  const f = g === 'f';
  if (minutes < 5 * 60) return f ? 'سهرانة؟' : 'سهران؟';
  if (minutes < 12 * 60) return f ? 'صباحچ خير' : 'صباحك خير';
  if (minutes < 17 * 60) return f ? 'هلا بيچ' : 'هلا بيك';
  return f ? 'مساچ خير' : 'مساك خير';
}

export function countSessions(n) {
  if (n === 0) return 'ولا محاضرة';
  if (n === 1) return 'محاضرة وحدة';
  if (n === 2) return 'محاضرتين';
  if (n <= 10) return `${n} محاضرات`;
  return `${n} محاضرة`;
}

export function countClashes(n) {
  if (n === 1) return 'تصادم واحد';
  if (n === 2) return 'تصادمين';
  return `${n} تصادمات`;
}
