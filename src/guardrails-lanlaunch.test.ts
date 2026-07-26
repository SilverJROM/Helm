import { describe, it, expect, afterEach } from 'vitest';
import { isPrivateLanAddress, isLaunchAddressAllowed, isLoopbackAddress } from './guardrails.js';

describe('LAN-launch guard (opt-in)', () => {
  const orig = process.env.HELM_ALLOW_LAN_LAUNCH;
  afterEach(() => { if (orig === undefined) delete process.env.HELM_ALLOW_LAN_LAUNCH; else process.env.HELM_ALLOW_LAN_LAUNCH = orig; });

  it('isPrivateLanAddress recognises RFC1918 ranges (and IPv4-mapped IPv6)', () => {
    expect(isPrivateLanAddress('192.168.254.140')).toBe(true);
    expect(isPrivateLanAddress('10.1.2.3')).toBe(true);
    expect(isPrivateLanAddress('172.16.0.1')).toBe(true);
    expect(isPrivateLanAddress('172.20.5.5')).toBe(true);
    expect(isPrivateLanAddress('::ffff:192.168.1.5')).toBe(true);
    // not private
    expect(isPrivateLanAddress('8.8.8.8')).toBe(false);
    expect(isPrivateLanAddress('172.32.0.1')).toBe(false); // just outside /12
    expect(isPrivateLanAddress('172.15.0.1')).toBe(false);
    expect(isPrivateLanAddress(undefined)).toBe(false);
  });

  it('default (env unset): loopback allowed, LAN rejected — unchanged behaviour', () => {
    delete process.env.HELM_ALLOW_LAN_LAUNCH;
    expect(isLaunchAddressAllowed('127.0.0.1')).toBe(true);
    expect(isLaunchAddressAllowed('::1')).toBe(true);
    expect(isLaunchAddressAllowed('192.168.254.140')).toBe(false); // JROM's LAN IP — the 403
  });

  it('opt-in (HELM_ALLOW_LAN_LAUNCH=1): loopback AND private LAN allowed; public still rejected', () => {
    process.env.HELM_ALLOW_LAN_LAUNCH = '1';
    expect(isLaunchAddressAllowed('127.0.0.1')).toBe(true);
    expect(isLaunchAddressAllowed('192.168.254.140')).toBe(true); // now allowed
    expect(isLaunchAddressAllowed('10.0.0.5')).toBe(true);
    expect(isLaunchAddressAllowed('8.8.8.8')).toBe(false);        // public internet still rejected
  });

  it('loopback helper unchanged', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.1')).toBe(false);
  });
});
