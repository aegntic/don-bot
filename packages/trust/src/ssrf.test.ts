import { describe, expect, test } from 'bun:test';
import { assertPublicUrl, classifyIp, isLoopbackHost, SsrfError } from './ssrf.ts';

describe('packages/trust/src/ssrf', () => {
  test('classifies public vs private vs never-routable IPv4 and IPv6 addresses', () => {
    expect(classifyIp('140.82.121.6')).toBe('public');
    expect(classifyIp('2606:4700:4700::1111')).toBe('public');

    expect(classifyIp('10.0.0.1')).toBe('private');
    expect(classifyIp('172.16.10.4')).toBe('private');
    expect(classifyIp('192.168.1.1')).toBe('private');
    expect(classifyIp('100.64.0.42')).toBe('private'); // Tailscale CGNAT
    expect(classifyIp('fc00::1')).toBe('private');
    expect(classifyIp('64:ff9b::10.0.0.1')).toBe('private');

    expect(classifyIp('127.0.0.1')).toBe('never');
    expect(classifyIp('169.254.169.254')).toBe('never');
    expect(classifyIp('::1')).toBe('never');
    expect(classifyIp('fe80::1')).toBe('never');
    expect(classifyIp('::ffff:127.0.0.1')).toBe('never');
    expect(isLoopbackHost('sub.localhost')).toBe(true);
  });

  test('assertPublicUrl blocks schemes, DNS rebinding, and allows public targets', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfError);
    await expect(
      assertPublicUrl('https://rebind.example/hook', {
        resolveHost: async () => ['100.64.0.10'],
      }),
    ).rejects.toBeInstanceOf(SsrfError);

    const ok = await assertPublicUrl('https://api.github.com/zen', {
      resolveHost: async () => ['140.82.121.6'],
    });
    expect(ok.addresses).toEqual(['140.82.121.6']);
  });
});
