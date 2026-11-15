// app/fruits.js — the two profile avatars as inline SVG illustrations in one shared style:
// same plum outline, same top-left light, same leaf greens, same little face.
// `simple` (auto below 30px) drops the face and fine details so they stay crisp at 20px.

const OUT = '#3a1830';
const GREEN = ['#b7ea6e', '#3f9f4a'];
let uid = 0;

function face(sw) {
  return `<g class="fr-face">
    <ellipse cx="38" cy="59" rx="3.1" ry="3.7" fill="${OUT}"/><ellipse cx="58" cy="59" rx="3.1" ry="3.7" fill="${OUT}"/>
    <circle cx="39.2" cy="57.6" r="1.1" fill="#fff"/><circle cx="59.2" cy="57.6" r="1.1" fill="#fff"/>
    <path d="M43 66.5q5 4.6 10 0" fill="none" stroke="${OUT}" stroke-width="${sw * 0.8}" stroke-linecap="round"/>
    <ellipse cx="31.5" cy="66.5" rx="5" ry="3" fill="#ff5f8a" opacity=".42"/><ellipse cx="64.5" cy="66.5" rx="5" ry="3" fill="#ff5f8a" opacity=".42"/>
  </g>`;
}

const shine = '<ellipse cx="33" cy="40" rx="8" ry="5" transform="rotate(-35 33 40)" fill="#fff" opacity=".55"/><circle cx="25.5" cy="50" r="2" fill="#fff" opacity=".5"/>';

function peach(id, simple) {
  const sw = simple ? 5 : 3.2;
  return `<defs>
      <radialGradient id="pb${id}" cx=".34" cy=".3" r=".85"><stop offset="0" stop-color="#fff2cc"/><stop offset=".33" stop-color="#ffc387"/><stop offset=".72" stop-color="#ff8c7c"/><stop offset="1" stop-color="#e44f7c"/></radialGradient>
      <linearGradient id="pl${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${GREEN[0]}"/><stop offset="1" stop-color="${GREEN[1]}"/></linearGradient>
    </defs>
    <path d="M48 27c0-6 2-10 5.5-13.5" fill="none" stroke="#6b3a1f" stroke-width="${sw + 0.4}" stroke-linecap="round"/>
    <path d="M52 18c6-9 18-11 26-7-5 8-15 12-26 7z" fill="url(#pl${id})" stroke="${OUT}" stroke-width="${sw * 0.82}" stroke-linejoin="round"/>
    ${simple ? '' : `<path d="M54 17.6c7-2 13.5-4 20-6" fill="none" stroke="#2f7a39" stroke-width="1.6" stroke-linecap="round" opacity=".7"/>`}
    <path d="M48 88c-21 0-34-14-34-32 0-17 12-30 27-30 3 0 5 1 7 3 2-2 4-3 7-3 15 0 27 13 27 30 0 18-13 32-34 32z" fill="url(#pb${id})" stroke="${OUT}" stroke-width="${sw}" stroke-linejoin="round"/>
    <path d="M48.6 30c4 6 5.2 12 4.2 18.5" fill="none" stroke="#d1406a" stroke-width="${simple ? 3 : 2.4}" stroke-linecap="round" opacity=".55"/>
    ${shine}${simple ? '' : face(sw)}`;
}

function dragon(id, simple) {
  const sw = simple ? 5 : 3.2;
  const bract = (d) => `<path d="${d}" fill="url(#dl${id})" stroke="${OUT}" stroke-width="${sw * 0.82}" stroke-linejoin="round"/>`;
  return `<defs>
      <radialGradient id="db${id}" cx=".34" cy=".3" r=".85"><stop offset="0" stop-color="#ffb3d6"/><stop offset=".38" stop-color="#f4479a"/><stop offset="1" stop-color="#a5125a"/></radialGradient>
      <linearGradient id="dl${id}" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#f4479a"/><stop offset=".45" stop-color="#f77fb8"/><stop offset=".62" stop-color="${GREEN[0]}"/><stop offset="1" stop-color="${GREEN[1]}"/></linearGradient>
    </defs>
    ${bract('M36 31c-8-4-12-10-13-17 8 2 13 7 16 14z')}
    ${bract('M60 31c8-4 12-10 13-17-8 2-13 7-16 14z')}
    ${bract('M44.5 27c-2.5-9-.5-16 5.5-21 3 8 2 15-1.5 21z')}
    <path d="M48 88c-19 0-31-14-31-32 0-19 13-32 31-32s31 13 31 32c0 18-12 32-31 32z" fill="url(#db${id})" stroke="${OUT}" stroke-width="${sw}" stroke-linejoin="round"/>
    ${bract('M20.5 63c-6-4-9.5-10-8.5-16.5 6.5 3 10.5 8 11.5 14.5z')}
    ${bract('M75.5 63c6-4 9.5-10 8.5-16.5-6.5 3-10.5 8-11.5 14.5z')}
    ${simple ? '' : `${bract('M31 80c-3.6-5-3.8-10.4-.6-15 3.6 4.4 3.8 9.8.6 15z')}${bract('M65 80c3.6-5 3.8-10.4.6-15-3.6 4.4-3.8 9.8-.6 15z')}`}
    ${shine}${simple ? '' : face(sw)}`;
}

/** Inline SVG of a fruit ('peach' | 'dragon'). */
export function fruitSVG(kind, size = 48, { label = '', simple = size < 30 } = {}) {
  const id = `f${++uid}`;
  const body = kind === 'peach' ? peach(id, simple) : dragon(id, simple);
  const a11y = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
  return `<svg class="fruit fruit--${kind}" width="${size}" height="${size}" viewBox="0 0 96 96" ${a11y}>${body}</svg>`;
}
