import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForStreamInput } from '../src/stream-recorder.js';

test('waitForStreamInput retries transient HLS 404 responses', async () => {
  let calls = 0;

  const result = await waitForStreamInput({
    inputUrl: 'https://stream.example/live.m3u8',
    timeoutMs: 500,
    intervalMs: 1,
    fetchImpl: async () => {
      calls += 1;
      return new Response(calls < 3 ? 'not ready' : '#EXTM3U', {
        status: calls < 3 ? 404 : 200
      });
    }
  });

  assert.equal(calls, 3);
  assert.equal(result.status, 200);
});

test('waitForStreamInput times out when HLS never becomes readable', async () => {
  let calls = 0;

  await assert.rejects(
    waitForStreamInput({
      inputUrl: 'https://stream.example/live.m3u8',
      timeoutMs: 5,
      intervalMs: 1,
      fetchImpl: async () => {
        calls += 1;
        return new Response('not ready', { status: 404 });
      }
    }),
    /stream_input_not_ready timeout=5ms/
  );

  assert(calls >= 1);
});
