import { describe, expect, it } from 'vitest';
import { copyName } from '../util/path';

describe('copyName (sidebar Duplicate, Typora naming)', () => {
  it('appends " (copy)" before the extension until free', () => {
    expect(copyName('note.md', new Set())).toBe('note (copy).md');
    expect(copyName('note.md', new Set(['note (copy).md']))).toBe('note (copy) (copy).md');
    expect(copyName('Note.md', new Set(['note (copy).md', 'note (copy) (copy).md']))).toBe('Note (copy) (copy) (copy).md');
    expect(copyName('README', new Set())).toBe('README (copy)');
  });
});
