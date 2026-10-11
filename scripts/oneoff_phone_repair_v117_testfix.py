from pathlib import Path
p=Path('tests/phone-fast-reaction-v2.test.mjs')
s=p.read_text()
old="assert.equal(PHONE_FAST_ACK_REVISION, 'talksys-phone-fast-ack-v2-r1');"
new="assert.equal(PHONE_FAST_ACK_REVISION, 'talksys-phone-fast-ack-v117-r1');"
if old not in s:
    raise SystemExit('missing PHONE_FAST_ACK_REVISION expectation')
p.write_text(s.replace(old,new,1))
