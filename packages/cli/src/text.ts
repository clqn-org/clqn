export const plain = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, ' ');
const segmenter = new Intl.Segmenter();
export const characters = (text: string) => Array.from(segmenter.segment(text), ({ segment }) => segment);
export function cells(char: string) {
  if (/^\p{Mark}+$/u.test(char)) return 0;
  return /[\p{Extended_Pictographic}\p{Regional_Indicator}ᄀ-ᅟ⺀-꓏가-힣豈-﫿！-｠￠-￦]/u.test(char) ? 2 : 1;
}
export const width = (text: string) => characters(text).reduce((total, char) => total + cells(char), 0);
export function take(text: string, limit: number) {
  let used = 0;
  let result = '';
  for (const char of characters(text)) {
    used += cells(char);
    if (used > limit) break;
    result += char;
  }
  return result;
}
export const clip = (text: string, limit: number) => (width(text) <= limit ? text : `${take(text, limit - 1)}…`);
export const pad = (text: string, limit: number) => text + ' '.repeat(Math.max(0, limit - width(text)));

export type Tone = 'accent' | 'muted' | 'active' | 'warning' | 'bold' | 'error';
export const accentColor = 38; // Teal-blue in the xterm 256-color palette.
const codes: Record<Tone, number | string> = {
  accent: `38;5;${accentColor}`,
  muted: 90,
  active: 92,
  warning: 93,
  bold: 1,
  error: 91,
};
/** Styles text with a named tone or raw SGR codes; each code is its own `ESC[...m` sequence. */
export type Paint = (text: string, tone: Tone | readonly number[]) => string;
export const painter =
  (color: boolean): Paint =>
  (text, tone) => {
    if (!color || !text) return text;
    const sgr = typeof tone === 'string' ? [codes[tone]] : tone;
    return sgr.length ? `${sgr.map((code) => `\x1b[${code}m`).join('')}${text}\x1b[0m` : text;
  };
