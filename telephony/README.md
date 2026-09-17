# TalkSys 電話ゲートウェイ

この `telephony/` は、Telnyx の着信を既存 TalkSys へ渡すための一時的なゲートウェイです。

**回答生成AIはここに持ちません。** 電話音声を既存 TalkSys の `/api/transcribe` と `/api/turn` に接続し、TalkSys 本体が現在使用している回答モデル・検索・grounding・truth gate をそのまま利用します。

将来、電話経路を TalkSys 本体へ統合した時点で、この Worker は削除する前提です。

## 分離ルール

電話開発は `telephony/` 配下だけで進めます。既存 production の `src/`、`/api/turn`、検索・grounding、回答品質改善、ブラウザ UI は変更しません。

## 現在の経路

```text
050番号 / Telnyx
  -> TeXML <Connect><Stream>
  -> PCMU 8kHz WebSocket
  -> TalkSys Telephony Gateway
  -> 簡易VADで発話単位に分割
  -> PCM16 WAVへ変換
  -> 既存TalkSys /api/transcribe
  -> 既存TalkSys /api/turn
  -> Gemini 3.5 Flash-Lite + 既存検索/grounding
```

電話 Worker から Gemini Live や別の回答モデルへ直接接続しません。

## 管理画面

`/phone` で以下を表示します。

- 発信者番号
- 着信番号
- 通話状態
- 開始時刻
- 会話内容（発信者 / TalkSys）

管理データは新規DBを作らず、既存の `talksys-conversation-logs` D1 に `phone_calls` / `phone_messages` テーブルだけ追加して利用します。録音はしません。

管理画面の会話内容APIは Bearer token 必須です。`TELEPHONY_ADMIN_TOKEN` が未設定なら `TELEPHONY_SHARED_TOKEN` を代用します。

## 複数同時通話

1通話ごとに独立した Telnyx Media WebSocket を処理します。会話履歴も各接続内で独立しています。

Durable Objects、R2、新規DB、別AI契約は追加しません。

## 現時点の未完了

TalkSys のテキスト回答までは接続済みですが、**TalkSys回答テキストを電話回線へ音声として返すTTS/音声変換アダプタは未接続**です。

ここは回答モデルとは別の電話輸送層として実装します。高価な Gemini Live に逃がさず、日本語TTSを最小コストでPCMUへ返せる方式を選定します。

## コスト方針

- 回答生成: 既存 TalkSys の Gemini 3.5 Flash-Lite
- STT: 既存 TalkSys の Whisper Large V3 Turbo
- Gemini Live: 不使用
- 録音: OFF
- R2: 不使用
- 新規 D1: 不使用
- 通話ログ: 既存 D1 のみ
- 1通話上限: 初期30分

## Secrets

ソースには秘密情報を保存しません。

- `TELEPHONY_SHARED_TOKEN`: Telnyx webhook / media の暫定保護
- `TELEPHONY_ADMIN_TOKEN`: 管理画面API用。省略時は shared token を利用

番号を本番運用する前に Telnyx webhook 署名検証へ移行します。

## 主なエンドポイント

- `/phone` — 日本語電話管理画面
- `/telephony-health` — ゲートウェイ状態
- `/api/calls` — 着信一覧（要管理トークン）
- `/api/calls/:id/messages` — 会話内容（要管理トークン）
- `/telnyx/voice` — TeXML instruction webhook
- `/telnyx/media` — Telnyx media WebSocket
- `/telnyx/stream-status` — Stream status callback

## テスト

```bash
node --test telephony/test.mjs
npx wrangler deploy --dry-run -c telephony/wrangler.jsonc
```

初期状態は `TELEPHONY_ENABLED=false` です。050番号が Active になるまでは番号を割り当てません。
