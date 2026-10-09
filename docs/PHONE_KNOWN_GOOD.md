# TalkSys 電話版 — Known-Good 基準・復旧ランブック

**確定日:** 2026-10-09 JST  
**対象:** `syouziroupc/talksys` / Telnyx 電話アクセス  
**状態:** 実電話で動作成功（ユーザー確認）

## Known-Good

```text
be57f65ae6f743b5924548a8eacc9c91293dfc47
```

この commit を、電話アクセスの最初の実電話 Known-Good とする。GitHub Actions の `Validate TalkSys` と `Deploy TalkSys production` が成功し、その後に実電話で会話動作を確認した。

## 現在の電話経路

```text
電話
  ↓
Telnyx
  ↓ /telnyx/voice
TeXML <Connect><Stream>
  ↓ wss://.../telnyx/media
PCMU / G.711 μ-law / 8 kHz
  ↓
90 Hz HPF → 適応VAD → TalkSys STT
  ↓
TalkSys本体 / Gemini 3.5 Flash Lite
  ↓
Cloudflare AI Gateway / xai/grok-tts
  ↓
G.711 μ-law / 8 kHz
  ↓
160 bytes / 20 ms pacing
  ↓
Telnyx WebSocket media.payload
  ↓
電話
```

## 崩してはいけない電話音声契約

- `codec="PCMU"`
- `bidirectionalMode="rtp"`
- `bidirectionalCodec="PCMU"`
- 8 kHz / mono / G.711 μ-law
- 20 ms = 160 bytes
- `media.payload` は PCMU payload bytes の base64
- MP3 / PCM16 / WAV全体を PCMU のつもりで直接送らない

## Grok TTS の重要な現行対策

`src/telephony/phone-tts.js` は HTTP `Content-Type` だけを信用せず、実バイトを sniff する。

- `ID3` / MPEG frame → actual MP3
- `RIFF....WAVE` → WAV
- JSON/HTML/XML/text → 拒否
- それ以外の binary → raw PCMU 候補

`audio/mpeg` と返されても実体が MP3 でなければ raw μ-law として扱える。actual MP3 の場合のみ PCM / 8000 Hz を再要求し、PCM16LE を Worker 内で G.711 μ-law に変換して Telnyx へ送る。

## 現行の主要値

```text
PHONE_TTS_MODEL         = xai/grok-tts
PHONE_TTS_DEFAULT_VOICE = ara
PHONE_TTS_SAMPLE_RATE   = 8000
PHONE_TTS_FRAME_MS      = 20
PHONE_TTS_FRAME_BYTES   = 160
PHONE_TTS_MAX_SECONDS   = 120

TELEPHONY_ENABLED             = true
TELEPHONY_SESSION_MAX_MINUTES = 30
TELEPHONY_END_SILENCE_MS      = 700
TELEPHONY_MIN_SPEECH_MS       = 320
TELEPHONY_MAX_UTTERANCE_MS    = 15000
TELEPHONY_MAX_SPOKEN_CHARS    = 1200
```

## 現行 revision

```text
integrated entry:
talksys-integrated-entry-v106-grounding-recovery-r1

telephony:
talksys-telephony-v87-grok-pcmu-paced
```

電話側 revision 文字列は MIME 修正後も同じなので、復旧基準は revision 文字列ではなく Known-Good commit SHA を使う。

## D1 / 管理

- binding: `TALKSYS_LOG_DB`
- database: `talksys-conversation-logs`
- tables: `phone_calls`, `phone_messages`
- management: `/phone`
- health: `/telephony-health`

主な status:

```text
starting / connecting / active / answer-error / tts-error / error / ended
```

## 重要ログ

```text
phone_tts_format_observed
phone_tts_codec_fallback
phone_tts_sent
phone_tts_error
phone_stt_error
phone_turn_error
phone_pipeline_error
phone_message_log_error
phone_duplicate_suppressed
phone_fast_reaction
```

`phone_tts_sent` は Worker 内の送信ループ完了を示すだけで、相手の電話で実際に聞こえたことを単独では証明しない。電話は実機受入試験が必要。

## 症状別切り分け

### 電話自体がつながらない
Telnyx → webhook URL → token → TeXML を確認。

### 通話は始まるが greeting がない
TTS / WebSocket start / outbound を確認。`phone_tts_*` ログを見る。

### greeting は聞こえるが音声認識しない
inbound PCMU / VAD / STT を確認。`phone_messages` に user text が入るかを見る。

### user text は残るが回答がない
TalkSys / Gemini / `phone_turn_error` / `answer-error` を確認。

### assistant text は残るが無音
Grok TTS / PCMU / Telnyx outbound を確認。

### ガチャガチャ・プツプツ
codec / container / sample rate / pacing を最優先で確認。

### 1回だけ喋って止まる
mark / clear / `assistantPlaying` / `currentMark` / `playbackGeneration` / `turnVersion` / AbortController を確認。

## 改造後に壊れた場合

まず Known-Good との差分を見る。

```bash
git rev-parse HEAD
git log --oneline --decorate -20
git diff be57f65ae6f743b5924548a8eacc9c91293dfc47 -- src/telephony
```

壊した commit が特定できるなら `git revert` を優先する。

原因不明で電話コアだけ戻す場合:

```bash
git switch -c rescue/phone-known-good

git restore \
  --source=be57f65ae6f743b5924548a8eacc9c91293dfc47 \
  -- src/telephony/codec.js \
     src/telephony/index.js \
     src/telephony/phone-tts.js \
     src/telephony/protocol.js \
     tests/phone-pcmu-v87.test.mjs
```

その後:

```bash
npm ci
npm run architecture:check
npm run architecture:graph
npm run reuse:check
npm test
npx wrangler deploy --dry-run
```

`src/integrated-entry.js` と `wrangler.jsonc` は電話以外も含むので、電話だけ壊れた場合に安易に丸ごと戻さない。

## Known-Good file blob SHA

```text
src/telephony/codec.js
  e16846af3ff4de269427618968778d5177b55a0c
src/telephony/index.js
  1b1ca94a52f4c1f3ef4b590120e565f3499e3061
src/telephony/phone-tts.js
  807afa9100a05ff437d6bad142d2891e49aefde3
src/telephony/protocol.js
  f6aeac6a252f315874ba2bfd4431fd674ad7472a
tests/phone-pcmu-v87.test.mjs
  25c82c20d2055876253356aa2123e88bdb92b1ed
src/integrated-entry.js
  7ccae65df309b7f3852d62e80069e9836a7eb8c8
wrangler.jsonc
  7edab89d8b8edee7b2a4b40462de0b6ab36cdc8e
```

## デプロイ後の受入試験

コードテスト合格だけでは電話は合格ではない。実電話で最低限:

1. 発信して接続
2. greeting が明瞭に聞こえる
3. 短い発話をする
4. user text が認識される
5. TalkSys の返答が聞こえる
6. もう一度話して会話が継続する
7. `/phone` に会話履歴が残る
8. 切断後に `ended` へ移る

を確認する。

## 今後の改造ルール

1. Known-Good を残して作業ブランチを切る
2. 一度に1つの層だけ変更する
3. PCMU codec contract を維持する
4. regression test を追加する
5. CI 全通過
6. production deploy
7. 実電話試験
8. 成功した commit を次の Known-Good とする

Telnyx protocol / TTS provider / codec / VAD / STT / 回答モデル / 割込 state machine を同時に変えない。
