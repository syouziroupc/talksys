# TalkSys Telephony Worker

TalkSys の電話接続を、既存ブラウザ版とは別 Worker として実装します。

## 分離ルール

電話開発は `telephony/` 配下だけで進めます。既存 production の `src/`、`/api/turn`、検索・grounding、回答品質改善、ブラウザ UI は変更しません。電話 Worker のデプロイも既存 TalkSys Worker とは別です。

## 現在の範囲

- `/phone` — 電話管理画面
- `/telephony-health` — 電話 Worker 状態
- `/telnyx/voice` — Telnyx TeXML instruction webhook
- `/telnyx/media` — Telnyx media WebSocket ⇄ Gemini Live
- `/telnyx/stream-status` — Stream status callback
- 通話本文・録音・顧客情報の永続保存は未使用

## 音声経路

```text
Telnyx inbound call
  -> TeXML <Connect><Stream>
  -> PCMU 8 kHz WebSocket
  -> TalkSys Telephony Worker
  -> PCM16 16 kHz -> Gemini Live
  -> Gemini PCM16 24 kHz
  -> 8 kHz downsample + PCMU
  -> Telnyx WebSocket
  -> caller
```

TeXML は `track="inbound_track"`、`bidirectionalMode="rtp"`、`bidirectionalCodec="PCMU"`、`bidirectionalSamplingRate="8000"` を使用します。

## 複数同時通話

共有セッションは作りません。Telnyx の Media WebSocket 1本につき Gemini Live セッションを1本作るため、複数着信は独立した Worker リクエストとして並行処理されます。電話接続だけのために Durable Objects、D1、R2 は追加しません。

Telnyx 側の Inbound Channel Limit は当面設定せず、固定 Channel Billing も有効化しません。必要性が出るまでは従量課金のまま運用します。

## コストガード

- Gemini の input/output transcription は初期 OFF
- 録音 OFF
- D1/R2 保存 OFF
- 1通話のセッション上限は初期 30 分
- Gemini Live の context window compression を有効化
- Gemini Live の session resumption を有効化

`TELEPHONY_TRANSCRIPTION=true` を明示した場合だけ文字起こしを有効化します。

## Secrets

ソースには秘密情報を保存しません。この Worker にだけ次を登録します。

```bash
npx wrangler secret put GEMINI_API_KEY -c telephony/wrangler.jsonc
npx wrangler secret put TELEPHONY_SHARED_TOKEN -c telephony/wrangler.jsonc
```

`TELEPHONY_SHARED_TOKEN` は接続初期段階の webhook / media URL 保護用です。番号を本番運用する前に Telnyx webhook 署名検証を追加します。

## テスト

```bash
node --test telephony/test.mjs
npx wrangler deploy --dry-run -c telephony/wrangler.jsonc
```

テスト対象には PCMU codec、TeXML、Gemini Live setup、transcription opt-in、session resumption が含まれます。

## 開発とデプロイ

```bash
npx wrangler dev -c telephony/wrangler.jsonc
npx wrangler deploy -c telephony/wrangler.jsonc
```

初期状態は `TELEPHONY_ENABLED=false` です。管理画面と health の確認後に有効化します。既存 TalkSys の production deploy workflow は使用しません。

## Telnyx Webhook

Worker 公開後、TeXML Application の webhook を次へ変更します。

```text
https://<talksys-telephony-worker>/telnyx/voice?token=<TELEPHONY_SHARED_TOKEN>
```

050 番号が Active になるまでは番号を Application へ割り当てません。

## 保存

接続安定後に必要なら追加します。基本方針は D1 を索引、R2 を長文・音声向けとしますが、当面はどちらも使いません。
