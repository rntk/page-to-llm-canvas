import { describe, expect, it } from 'vitest';
import { decodeEntities } from './htmlEntities.js';

describe('decodeEntities', () => {
  it('decodes supported named and numeric references', () => {
    expect(decodeEntities('&amp; &lt; &#65; &#x42;')).toBe('& < A B');
  });

  it('leaves malformed and unsupported references unchanged', () => {
    expect(decodeEntities('&unknown; &#0; &amp')).toBe('&unknown; &#0; &amp');
  });

  it('applies HTML numeric-reference C1 replacements', () => {
    expect(decodeEntities('&#128;')).toBe('€');
  });
});
