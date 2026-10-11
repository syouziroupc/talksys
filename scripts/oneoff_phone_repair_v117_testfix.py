from pathlib import Path
p=Path('tests/phone-fast-reaction-v2.test.mjs')
s=p.read_text()
old="""test('phone fast reaction v2 keeps answer generation concurrent with the acknowledgement and preserves transport', () => {
  assert.equal(PHONE_FAST_ACK_REVISION, 'talksys-phone-fast-ack-v2-r1');
  const turnStart = source.indexOf('const turnPromise=answerWithTalkSys');
  const ackSpeak = source.indexOf('await speak(ackText');
  assert.ok(turnStart >= 0 && ackSpeak > turnStart, 'TalkSys answer generation must start before the acknowledgement is played');
  assert.match(source, /spokenBackchannel=ackPrepared\\?ackText:''/);
  assert.match(source, /streamPcmu20ms\\(audio\\.bytes/);
  assert.match(source, /talksys-telephony-v87-grok-pcmu-paced/);
  assert.match(source, /const FAST_ACK_TEXT = 'はい。'/);
});
"""
new="""test('phone fast reaction v117 starts the cached acknowledgement before STT wait while preserving answer and transport paths', () => {
  assert.equal(PHONE_FAST_ACK_REVISION, 'talksys-phone-fast-ack-v117-r1');
  const earlyAck = source.indexOf('const earlyAckPromise=');
  const sttAwait = source.indexOf('stt=await transcribeSamples');
  const turnStart = source.indexOf('const turnPromise=answerWithTalkSys');
  assert.ok(earlyAck >= 0 && sttAwait > earlyAck, 'cached acknowledgement must be scheduled before waiting for STT');
  assert.ok(turnStart > sttAwait, 'TalkSys answer generation remains transcript-dependent');
  assert.match(source, /spokenBackchannel=ackText/);
  assert.doesNotMatch(source, /await speak\\(ackText,\\{purpose:'ack'/);
  assert.match(source, /streamPcmu20ms\\(audio\\.bytes/);
  assert.match(source, /talksys-telephony-v87-grok-pcmu-paced/);
  assert.match(source, /const FAST_ACK_TEXT = 'はい。'/);
});
"""
if old not in s:
    raise SystemExit('missing old phone fast reaction ordering contract')
p.write_text(s.replace(old,new,1))
