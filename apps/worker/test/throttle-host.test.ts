/**
 * スロットルの鍵に使うホスト正規化（BOXIV）。
 *
 * これが無いと IP 単位の制御が **全部** 無意味になる。cf-connecting-ip は実際に
 * IPv6 で届き（実測 240a:61:...）、IPv6 は 1 契約に /64 が割り当たるのが標準なので、
 * アドレス 1 個ずつを鍵にすると攻撃者は 2^64 個の送信元を自由に使える。
 */
import { describe, expect, it } from 'vitest';
import { normalizeThrottleHost, throttleBucket } from '@line-crm/db';

describe('normalizeThrottleHost', () => {
  it('IPv4 はそのまま', () => {
    expect(normalizeThrottleHost('203.0.113.10')).toBe('203.0.113.10');
  });

  it('IPv6 は /64 に丸める（同一 /64 の別アドレスが同じ鍵になる）', () => {
    const a = normalizeThrottleHost('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    const b = normalizeThrottleHost('2001:db8:1:2:0:0:0:1');
    expect(a).toBe('2001:db8:1:2::/64');
    expect(b).toBe(a);
  });

  it('/64 が違えば別の鍵', () => {
    expect(normalizeThrottleHost('2001:db8:1:2::1')).not.toBe(
      normalizeThrottleHost('2001:db8:1:3::1'),
    );
  });

  it('省略記法を展開してから丸める', () => {
    expect(normalizeThrottleHost('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(normalizeThrottleHost('::1')).toBe('0:0:0:0::/64');
  });

  it('先頭 0 の有無で別の鍵にならない', () => {
    expect(normalizeThrottleHost('2001:0db8:0001:0002::1')).toBe(
      normalizeThrottleHost('2001:db8:1:2::1'),
    );
  });

  it('大文字小文字で別の鍵にならない', () => {
    expect(normalizeThrottleHost('2001:DB8:1:2:AAAA::1')).toBe(
      normalizeThrottleHost('2001:db8:1:2:aaaa::1'),
    );
  });

  it('IPv4 射影アドレスは IPv4 として扱う（全部 0:0:0:0 に潰れない）', () => {
    expect(normalizeThrottleHost('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(normalizeThrottleHost('::ffff:198.51.100.9')).toBe('198.51.100.9');
    // 潰れていたら、無関係な相手同士が 1 つの枠を共有してしまう
    expect(normalizeThrottleHost('::ffff:192.0.2.1')).not.toBe(
      normalizeThrottleHost('::ffff:198.51.100.9'),
    );
  });

  it('末尾に IPv4 記法を持つ IPv6 も /64 に丸まる', () => {
    expect(normalizeThrottleHost('2001:db8:1:2::192.0.2.1')).toBe('2001:db8:1:2::/64');
  });

  it('ゾーンインデックスは落とす', () => {
    expect(normalizeThrottleHost('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('空 / 未取得は unknown', () => {
    expect(normalizeThrottleHost(null)).toBe('unknown');
    expect(normalizeThrottleHost('   ')).toBe('unknown');
  });

  it('解釈できない形は丸めずそのまま（安全側）', () => {
    expect(normalizeThrottleHost('2001:db8::1::2')).toBe('2001:db8::1::2');
    expect(normalizeThrottleHost('zzzz::1')).toBe('zzzz::1');
  });
});

describe('throttleBucket', () => {
  it('IPv6 の同一 /64 は同じ bucket になる', () => {
    expect(throttleBucket('login_fail', '2001:db8:1:2:aaaa::1')).toBe(
      throttleBucket('login_fail', '2001:db8:1:2:ffff::9'),
    );
  });

  it('区切りは | なので IPv6 の : と混ざらない', () => {
    const b = throttleBucket('login_fail', '2001:db8:1:2::1', 'alert');
    expect(b.split('|')).toHaveLength(3);
    expect(b).toBe('login_fail|2001:db8:1:2::/64|alert');
  });
});
