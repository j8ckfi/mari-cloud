import { describe, it, expect } from 'vitest';
import {
  previewLabel,
  previewHost,
  previewUrl,
  parsePreviewHost,
  PreviewHostError,
  DEFAULT_ZONE,
} from '../src/preview/url';

describe('previewHost / previewUrl', () => {
  it('builds the single-label host in the locked shape', () => {
    expect(previewLabel({ port: 5173, computer: 'alpha', user: 'jack' })).toBe(
      '5173--alpha--jack',
    );
    expect(previewHost({ port: 5173, computer: 'alpha', user: 'jack' })).toBe(
      '5173--alpha--jack.mari.sh',
    );
    expect(DEFAULT_ZONE).toBe('mari.sh');
  });

  it('builds an https URL with a default and custom path', () => {
    expect(previewUrl({ port: 8080, computer: 'c1', user: 'u1' })).toBe(
      'https://8080--c1--u1.mari.sh/',
    );
    expect(previewUrl({ port: 8080, computer: 'c1', user: 'u1' }, 'mari.sh', 'app/index')).toBe(
      'https://8080--c1--u1.mari.sh/app/index',
    );
  });

  it('honors a private-instance zone', () => {
    expect(previewHost({ port: 3000, computer: 'c', user: 'u' }, 'dev.example.com')).toBe(
      '3000--c--u.dev.example.com',
    );
  });
});

describe('parsePreviewHost', () => {
  it('round-trips build → parse for many inputs', () => {
    const cases = [
      { port: 5173, computer: 'alpha', user: 'jack' },
      { port: 80, computer: 'a', user: 'b' },
      { port: 65535, computer: 'web-1', user: 'user-2' },
    ];
    for (const parts of cases) {
      const host = previewHost(parts);
      expect(parsePreviewHost(host)).toEqual({ ...parts, zone: 'mari.sh' });
    }
  });

  it('parses a full URL and recovers the zone', () => {
    expect(parsePreviewHost('https://3000--c1--u1.dev.example.com/some/path')).toEqual({
      port: 3000,
      computer: 'c1',
      user: 'u1',
      zone: 'dev.example.com',
    });
  });
});

describe('preview host validation', () => {
  it('rejects a field containing the separator', () => {
    expect(() => previewLabel({ port: 80, computer: 'a--b', user: 'u' })).toThrow(PreviewHostError);
  });

  it('rejects uppercase, leading/trailing hyphen, and empty fields', () => {
    expect(() => previewLabel({ port: 80, computer: 'Alpha', user: 'u' })).toThrow(PreviewHostError);
    expect(() => previewLabel({ port: 80, computer: '-a', user: 'u' })).toThrow(PreviewHostError);
    expect(() => previewLabel({ port: 80, computer: 'a-', user: 'u' })).toThrow(PreviewHostError);
    expect(() => previewLabel({ port: 80, computer: '', user: 'u' })).toThrow(PreviewHostError);
  });

  it('rejects out-of-range and non-integer ports', () => {
    expect(() => previewLabel({ port: 0, computer: 'a', user: 'u' })).toThrow(PreviewHostError);
    expect(() => previewLabel({ port: 70000, computer: 'a', user: 'u' })).toThrow(PreviewHostError);
    expect(() => previewLabel({ port: 3.5, computer: 'a', user: 'u' })).toThrow(PreviewHostError);
  });

  it('rejects a label exceeding the 63-char DNS limit', () => {
    const longUser = 'u'.repeat(60);
    expect(() => previewLabel({ port: 8080, computer: 'comp', user: longUser })).toThrow(
      /exceeds DNS limit/,
    );
  });

  it('rejects a parse with the wrong field count or missing zone', () => {
    expect(() => parsePreviewHost('5173--alpha.mari.sh')).toThrow(PreviewHostError); // 2 fields
    expect(() => parsePreviewHost('5173--a--b--c.mari.sh')).toThrow(PreviewHostError); // 4 fields
    expect(() => parsePreviewHost('5173--a--b')).toThrow(PreviewHostError); // no zone
  });
});
