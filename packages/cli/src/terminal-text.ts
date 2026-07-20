import stringWidth from 'string-width';

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function splitGraphemes(value: string): string[] {
  return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
}

export function truncateDisplayText(value: string, maxWidth: number, marker = '…'): string {
  if (!Number.isSafeInteger(maxWidth) || maxWidth < 1) {
    throw new RangeError('maxWidth must be a positive safe integer');
  }
  if (stringWidth(value) <= maxWidth) return value;

  const markerWidth = stringWidth(marker);
  if (markerWidth > maxWidth) return '';
  let result = '';
  let resultWidth = 0;
  for (const grapheme of splitGraphemes(value)) {
    const graphemeWidth = stringWidth(grapheme);
    if (resultWidth + graphemeWidth + markerWidth > maxWidth) break;
    result += grapheme;
    resultWidth += graphemeWidth;
  }
  return `${result}${marker}`;
}

export function wrapDisplayText(value: string, maxWidth: number): string {
  if (!Number.isSafeInteger(maxWidth) || maxWidth < 1) {
    throw new RangeError('maxWidth must be a positive safe integer');
  }

  const wrapped: string[] = [];
  for (const sourceLine of value.split('\n')) {
    let line = '';
    let lineWidth = 0;
    let emittedLine = false;
    for (const grapheme of splitGraphemes(sourceLine)) {
      const graphemeWidth = stringWidth(grapheme);
      if (line !== '' && lineWidth + graphemeWidth > maxWidth) {
        wrapped.push(line);
        emittedLine = true;
        line = '';
        lineWidth = 0;
      }
      if (graphemeWidth > maxWidth) {
        wrapped.push(truncateDisplayText(grapheme, maxWidth));
        emittedLine = true;
        continue;
      }
      line += grapheme;
      lineWidth += graphemeWidth;
    }
    if (line !== '' || !emittedLine) wrapped.push(line);
  }
  return wrapped.join('\n');
}
