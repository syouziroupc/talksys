import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { guardFfmpegStdin, isExpectedFfmpegStdinTermination } from '../discord-voice-smoke/src/ffmpeg-stdin.mjs';

test('classifies ffmpeg stdin close errors as expected termination', () => {
  assert.equal(isExpectedFfmpegStdinTermination(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })), true);
  assert.equal(isExpectedFfmpegStdinTermination(Object.assign(new Error('write EOF'), { code: 'EOF' })), true);
  assert.equal(isExpectedFfmpegStdinTermination(Object.assign(new Error('stream destroyed'), { code: 'ERR_STREAM_DESTROYED' })), true);
  assert.equal(isExpectedFfmpegStdinTermination(Object.assign(new Error('permission denied'), { code: 'EACCES' })), false);
});

test('guard consumes expected pipe errors and reports unexpected errors', () => {
  const stream = new EventEmitter();
  const expected = [];
  const unexpected = [];
  const dispose = guardFfmpegStdin(stream, {
    onExpected: (error) => expected.push(error.code),
    onUnexpected: (error) => unexpected.push(error.code),
  });

  stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  stream.emit('error', Object.assign(new Error('write EOF'), { code: 'EOF' }));
  stream.emit('error', Object.assign(new Error('bad descriptor'), { code: 'EBADF' }));

  assert.deepEqual(expected, ['EPIPE', 'EOF']);
  assert.deepEqual(unexpected, ['EBADF']);
  dispose();
});

test('repeated barge-in style pipe termination does not throw', () => {
  for (let i = 0; i < 20; i += 1) {
    const stream = new EventEmitter();
    guardFfmpegStdin(stream);
    assert.doesNotThrow(() => {
      stream.emit('error', Object.assign(new Error(i % 2 ? 'write EOF' : 'write EPIPE'), { code: i % 2 ? 'EOF' : 'EPIPE' }));
    });
  }
});
