import { describe, expect, test } from 'bun:test';
import { parseDevToolsActivePortFile, parseDevToolsPortFromStderr } from './cdp-stream.ts';

describe('packages/ui/src/cdp-stream', () => {
  test('parseDevToolsPortFromStderr parses 127.0.0.1, localhost, and IPv6 DevTools URLs', () => {
    expect(
      parseDevToolsPortFromStderr(
        'noise line\nDevTools listening on ws://127.0.0.1:41987/devtools/browser/abc-123\nmore logs',
      ),
    ).toBe(41987);
    expect(
      parseDevToolsPortFromStderr(
        'DevTools listening on ws://localhost:9222/devtools/browser/def-456',
      ),
    ).toBe(9222);
    expect(
      parseDevToolsPortFromStderr('DevTools listening on ws://[::1]:55123/devtools/browser/v6'),
    ).toBe(55123);

    expect(parseDevToolsPortFromStderr('DevTools listening on ws://127.0.0.1:0/bad')).toBeNull();
    expect(
      parseDevToolsPortFromStderr('DevTools listening on ws://127.0.0.1:70000/bad'),
    ).toBeNull();
    expect(parseDevToolsPortFromStderr('unrelated chromium stderr')).toBeNull();
  });

  test('parseDevToolsActivePortFile parses DevToolsActivePort file cleanly', () => {
    expect(parseDevToolsActivePortFile('41234\n/devtools/browser/abc\n')).toBe(41234);
    expect(parseDevToolsActivePortFile('\r\n  9333 \r\n/devtools/browser/xyz\r\n')).toBe(9333);

    expect(parseDevToolsActivePortFile('')).toBeNull();
    expect(parseDevToolsActivePortFile('not-a-port\n/devtools/browser/abc\n')).toBeNull();
    expect(parseDevToolsActivePortFile('0\n/devtools/browser/abc\n')).toBeNull();
    expect(parseDevToolsActivePortFile('65536\n/devtools/browser/abc\n')).toBeNull();
  });
});
