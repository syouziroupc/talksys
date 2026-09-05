# TalkSys

TalkSys v15.0 は、Cloudflare Workers / Durable Objects / Workers AI / `@cloudflare/voice` を使った日本語リアルタイム音声アシスタントです。文字チャット、音声会話、Web検索、画面共有、画面上の操作対象案内を同じ会話コンテキストで扱います。

## v15.0 の設計方針

Gemini Liveのような「会話の内容」と「応答のテンポ」を両立するため、全ターンを1つの大型モデルへ送らず、処理を3段階に分離しています。

- **Live path**: `@cf/qwen/qwen3.8-27b`
  - 短い雑談、相槌、通常会話
  - thinking無効
  - ストリーミング
  - 低TTFTを優先
- **Quality path**: `@cf/zai-org/glm-5.3-flash`
  - 相談、比較、説明、複数論点を含む会話
  - 利用できない契約では自動的にQwenへfallback
- **Grounded path**: `@cf/openai/gpt-oss-120b`
  - Web検索が必要な外部事実
  - GLM-5.3 Flash、Qwen 3.8 27Bの順にfallback

Workers AIの`x-session-affinity`を会話セッション単位で付与し、対応モデルではprefix cachingのヒット率を上げる構成です。

## 日本語STT

- Realtime: `@cf/deepgram/nova-3`
- Accurate fallback: `@cf/openai/whisper-large-v3-turbo`
- Disagreement resolver: `@cf/qwen/qwen3.8-27b`
- 16 kHz mono PCM、40 ms chunk
- 高信頼度のNova-3 finalはWhisperを待たず即ターン確定
- 低信頼度時だけWhisper + resolverで再確認
- assistant音声の再入力抑制とbarge-in対応

この構成により、認識精度を維持しつつ、通常会話で毎回Whisper完了を待つ遅延を避けます。

## 日本語TTS

- Server primary: `@cf/myshell-ai/melotts`
- Server TTSが利用できない場合は、ブラウザーに存在する日本語 `SpeechSynthesis` voiceのみをfallbackとして使用
- 非日本語device voiceへのfallbackは禁止

## 会話・検索

- Durable Objects + SQLiteで会話履歴を保持
- typed chat / voiceは同じAgent WebSocketを共有
- 普通の会話は検索しない
- 外部事実が必要な質問だけWeb検索
- Google HTML / DuckDuckGo HTML / Bing HTML / 日本語Wikipedia / Google News RSS
- 取得ページ本文のevidence抽出
- `@cf/baai/bge-reranker-base` によるreranking
- 検索中は先に短い待ち発話を返してTTSを開始

## Web版の主なroute

- `/` : チャット / 音声 / 画面共有UI
- `/health` : 基本稼働確認
- `/voice-health` : 現在のvoice revisionとモデル構成
- `/api/chat` : 文字会話API
- `/api/locate` : 共有画面から対象を特定するVision API
- `/api/model-smoke` : Live model smoke test
- `/api/quality-model-smoke` : Quality model smoke test
- `/api/grounded-model-smoke` : Grounded model smoke test
- `/api/voice-model-bench` : Qwen / GLMのTTFT・総時間比較
- `/api/voice-smoke` : server-side日本語TTS smoke test
- `/agents/talk-sys-voice-agent/default` : Durable Object Agent WebSocket

## Windows / Desktop Companion

`desktop/` はElectron製のデスクトップ版です。

- プライマリ画面の静止画キャプチャー
- `/api/locate` を利用した対象位置特定
- デスクトップ上の透明・常時最前面オーバーレイ
- 対象位置への赤い矢印と円の描画
- オーバーレイ越しのクリック透過
- PNGスクリーンショット保存
- 文字会話 / 音声入力 / 回答読み上げ

## ローカル検証

```bash
npm install
npm test
npx wrangler deploy --dry-run
```

GitHub Actionsでは、構文チェック、アーキテクチャ/APIテスト、Wrangler dry-run、Web/Desktopスクリーンショット生成、production deploy、`/voice-health` revision確認を行います。

## Production

既定URL:

```text
https://talksys.syouziroupc.workers.dev
```

GitHub Actionsからproductionへdeployする場合、Repository Secretsに以下が必要です。

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

ソースコードへCloudflare認証情報を保存しないでください。

デプロイ後は最低限、以下を確認します。

```text
GET /voice-health
GET /api/model-smoke
GET /api/quality-model-smoke
GET /api/grounded-model-smoke
GET /api/voice-model-bench
GET /api/voice-smoke
WebSocket /agents/talk-sys-voice-agent/default
```
