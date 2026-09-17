# TalkSys Telephony Worker

TalkSys の電話接続を既存ブラウザ版から分離して実装する独立 Worker です。

## 分離方針

このディレクトリの実装では、既存 production の `src/`、`/api/turn`、検索・grounding、Gemini 回答品質改善、ブラウザ UI を変更しません。電話系の検証・デプロイも既存 TalkSys Worker とは別に行います。

## 現在の対象

- `/phone` — 電話管理画面
- `/telephony-health` — 電話 Worker の状態確認
- `/telnyx/voice` — Telnyx TeXML instruction webhook
- `/telnyx/media` — Telnyx media WebSocket と Gemini Live の双方向ブリッジ
- `/telnyx/stream-status` — Stream status callback
- 保存機能は無効。D1/R2 は電話接続安定後に追加

## 音声経路

```text
Telnyx inbound call
  -> TeXML <Connect><Stream>
  -> PCMU 8 kHz WebSocket
  -> TalkSys Telephony Worker
  -> PCM16 -> Gemini Live
  -> Gemini PCM16 24 kHz
  -> 8 kHz downsample + PCMU
  -> Telnyx WebSocket
  -> caller
```

TeXML 側は `track="inbound_track"`、`bidirectionalMode="rtp"`、`bidirectionalCodec="PCMU"`、`bidirectionalSamplingRate="8000"` を使用します。既存 TalkSys の音声経路とは独立しています。

## Secrets

ソースには秘密情報を保存しません。デプロイ前に、この Worker に個別に次を登録します。

```bash
npx wrangler secret put GEMINI_API_KEY -c telephony/wrangler.jsonc
npx wrangler secret put TELEPHONY_SHARED_TOKEN -c telephony/wrangler.jsonc
```

`TELEPHONY_SHARED_TOKEN` は TeXML webhook と media WebSocket の暫定アクセス制御です。本番番号を割り当てる前に Telnyx 側の署名検証を含めた認証強化を再確認します。

## 開発

リポジトリルートから実行します。

```bash
npx wrangler dev -c telephony/wrangler.jsonc
```

初期状態では `TELEPHONY_ENABLED=false` なので、管理画面と health 以外の通話入口は閉じています。

## デプロイ

既存 TalkSys の `npm run deploy` や production workflow は使用しません。電話 Worker だけを明示的にデプロイします。

```bash
npx wrangler deploy -c telephony/wrangler.jsonc
```

デプロイと実通話を行う前に、`TELEPHONY_ENABLED`、Secrets、Webhook 認証、Telnyx TeXML Application の URL を確認します。

## Telnyx 設定

最終的な TeXML Application の webhook は次の形です。

```text
https://<talksys-telephony-worker>/telnyx/voice?token=<TELEPHONY_SHARED_TOKEN>
```

050 番号が Active になるまでは番号を Application に割り当てません。

## 保存

現在は `TELEPHONY_STORAGE_MODE=disabled` です。通話本文、録音、顧客情報は保存しません。電話接続と管理画面が安定した後、必要に応じて D1 を索引、R2 を長文・音声向けに追加します。
