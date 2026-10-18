import { describe, it } from 'vitest';
import { countOccurrences, countTextStats } from './textStats';
import { countChars } from './countChars';

function makeText(chars: number): string {
  const unit = '汉字软件测试，abc 123。\n';
  let out = '';
  while (out.length < chars) out += unit;
  return out.slice(0, chars);
}

describe('perf 基线（临时基准，量完即删）', () => {
  it('countTextStats vs countChars', () => {
    for (const size of [10_000, 200_000, 1_000_000, 4_000_000]) {
      const text = makeText(size);
      let t = performance.now();
      for (let i = 0; i < 3; i += 1) countTextStats(text);
      const statsMs = (performance.now() - t) / 3;
      t = performance.now();
      for (let i = 0; i < 3; i += 1) countChars(text);
      const charsMs = (performance.now() - t) / 3;
      t = performance.now();
      for (let i = 0; i < 3; i += 1) countOccurrences(text, '软件');
      const occMs = (performance.now() - t) / 3;
      console.log(
        `size=${String(text.length).padStart(9)}  countTextStats=${statsMs.toFixed(1)}ms  countChars=${charsMs.toFixed(1)}ms  countOccurrences=${occMs.toFixed(1)}ms`,
      );
    }
  }, 180_000);
});
