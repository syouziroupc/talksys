export function isExpectedFfmpegStdinTermination(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || error || '');
  return code === 'EPIPE'
    || code === 'EOF'
    || code === 'ERR_STREAM_DESTROYED'
    || /(?:write\s+)?(?:EPIPE|EOF)|stream\s+(?:is\s+)?destroyed/i.test(message);
}

export function guardFfmpegStdin(stream, { onExpected, onUnexpected } = {}) {
  if (!stream?.on) return () => {};
  const onError = (error) => {
    if (isExpectedFfmpegStdinTermination(error)) {
      try { onExpected?.(error); } catch {}
      return;
    }
    try { onUnexpected?.(error); } catch {}
  };
  stream.on('error', onError);
  return () => {
    try { stream.off?.('error', onError); } catch {}
  };
}
