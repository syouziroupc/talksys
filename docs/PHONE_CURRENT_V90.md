# TalkSys 電話版 — Current V90 state

更新: 2026-10-10 JST

この文書は `docs/PHONE_KNOWN_GOOD.md` を置き換えない。`PHONE_KNOWN_GOOD.md` の `be57f65ae6f743b5924548a8eacc9c91293dfc47` は、実電話で確認済みの最初の復旧基準として残す。

## 現在の本番実装

- V90 runtime merge: `146ab8ad87ec16fc37a2efafcc98f13ec553e9c4`
- V90 production deploy: GitHub Actions `Deploy TalkSys production` run 633 / success
- telephony revision: `talksys-telephony-v90-fast-ack-telemetry`
- current repository hardening head: `cac2d88ed38f05de578b3d829c76282d4eb34277`
- transport contract: Telnyx RTP / PCMU / G.711 μ-law / 8 kHz / 160 bytes per 20 ms

`cac2d88...` は workflow / regression guardrail の変更であり、Worker runtime source は変更していない。現在のWorker runtimeはV90 deployを基準とする。

## V90で追加したもの

### 1. 発話受理ACK

Whisper STTが意味のある文字列を確定した後、キャッシュ済みPCMUの短い受理音声を可能なら先行再生する。

- STT未確定の音だけではACKしない
- ACK用に毎回Grok TTSを待たない
- cacheが存在するときだけTalkSysへ spoken backchannel を渡す
- 本回答のTalkSys turnとACK再生を可能な範囲で並行化する

### 2. 電話レイテンシtelemetry

D1 `phone_latency_events` に call / turn 単位で主なstageを保存する。

代表stage:

```text
speech_end
vad_pass
stt_start
stt_end
ack_cache_hit
ack_cache_miss
talksys_start
talksys_end
pending_stt_wait_start
pending_stt_wait_end
tts_start
tts_ready
first_pcmu
tts_end
turn_complete
```

管理画面 `/phone` に電話ターン遅延タイムラインを表示し、API `/phone/api/calls/{callId}/latency` からも取得できる。

### 3. TTS / transport

既存のKnown-Good PCMU経路は維持する。

```text
Grok TTS
  -> byte sniff
  -> raw μ-law または PCM fallback -> μ-law
  -> PCMU 8 kHz
  -> 160 bytes / 20 ms
  -> Telnyx media.payload
```

PCMU/RTP、Grok MIME対策、20 ms pacingは速度改善のために変更しない。

## Production sync hardening

Telnyx production workflowは次の順序を守る。

1. GitHub production secretsの存在確認
2. Telnyx API preflight
   - API認証
   - 対象050番号の所有確認
   - 同名TeXML applicationの重複確認
3. Cloudflare Workerへ `TELEPHONY_SHARED_TOKEN` を同期
4. Telnyx TeXML application / 050番号をupsert
5. live `/telephony-health` とTeXML RTP/PCMU contractを確認
6. live media WebSocketでgreeting audioを確認

`TELEPHONY_SHARED_TOKEN` はproduction secretを単一の基準とし、workflow実行ごとのランダムrotationは行わない。

## 削除した旧ツール

現行V90を旧実装へ戻す危険があった以下を削除した。

- `.github/workflows/hotfix-phone-pcmu-once.yml`
- `.diagnostics/apply-phone-pcmu-hotfix.py`
- temporary regression diagnostic workflow / trigger

旧one-shot hotfixはV86 revisionを前提にmainへ直接pushし、そのままWorkerをdeployする構造だったため、現行系には残さない。

## 現在残る外部設定条件

Telnyx production syncを完走するにはGitHub Actions `production` environmentで以下が利用可能である必要がある。

- `TELNYX_API_KEY`（または互換名）
- `TELEPHONY_SHARED_TOKEN`
- Cloudflare deployment credential

秘密値をrepository、workflow本文、ドキュメントへ直書きしない。

## 受入基準

CI / deploy successだけでPSTN受入完了とはしない。最終的には実電話で以下を確認する。

1. 接続・greeting
2. 発話後の受理ACK
3. STT文字列が管理画面へ残る
4. TalkSys本回答が聞こえる
5. 2〜3ターン継続する
6. `/phone` にlatency timelineが残る
7. 切断後 `ended` になる

実電話でV90受入が完了した時点で、そのcommit/deployを次のKnown-Good候補として昇格する。