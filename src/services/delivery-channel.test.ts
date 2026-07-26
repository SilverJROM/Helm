// F2 round-7 (finding #1): the delivery channel MUST be server-authoritative — derived only from the
// authenticated route params, NEVER from a client-supplied body/query `channel` key. This guards against a
// wrong-channel stream/ack receiving + auto-ACKing another project/agent channel's delivery notifications.
import { describe, it, expect } from 'vitest';
import { deliveryChannelFor } from './delivery-channel.js';

describe('deliveryChannelFor — server-authoritative channel resolution', () => {
  it('project route (pid) → project:<pid> (matches the POST message-handler derivation)', () => {
    expect(deliveryChannelFor({ pid: '7', sid: 's1' })).toBe('project:7');
    expect(deliveryChannelFor({ pid: 42, sid: 's1' })).toBe('project:42');
  });

  it('studio route (agentId, no pid) → studio:<agentId>', () => {
    expect(deliveryChannelFor({ agentId: '3', sid: 's1' })).toBe('studio:3');
  });

  it('no project/agent scope → session:<sid> fallback', () => {
    expect(deliveryChannelFor({ sid: 'abc' })).toBe('session:abc');
  });

  it('a client-supplied channel key is STRUCTURALLY ignored (only pid/agentId/sid are read)', () => {
    // Even if a malicious body/query smuggled a `channel` into params, the resolver never consults it.
    const params: any = { pid: '7', sid: 's1', channel: 'project:999', query: { channel: 'studio:evil' } };
    expect(deliveryChannelFor(params)).toBe('project:7'); // NOT project:999 / studio:evil
  });

  it('pid takes precedence over agentId when both are present (defensive)', () => {
    expect(deliveryChannelFor({ pid: '7', agentId: '3', sid: 's1' })).toBe('project:7');
  });

  it('empty-string / null / undefined pid or agentId does not produce a colliding "project:"/"studio:" key', () => {
    expect(deliveryChannelFor({ pid: '', agentId: '', sid: 's1' })).toBe('session:s1');
    expect(deliveryChannelFor({ pid: null as any, agentId: undefined, sid: 's1' })).toBe('session:s1');
    expect(deliveryChannelFor(undefined)).toBe('session:undefined');
  });
});
