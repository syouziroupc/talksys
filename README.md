# TalkSys

TalkSys v14.1 は、Cloudflare Workers / Durable Objects / Workers AI を使った日本語リアルタイム音声アシスタントです。文字チャット、音声会話、Web検索、画面共有、画面上の操作対象案内を同じ会話コンテキストで扱います。

## 現行アーキテクチャ

- Worker entrypoint: `src/worker-v14.js`
- Voice revision: `cloudflare-live-v14.1`
- Conversation persistence: Durable Objects + SQLite
- Typed chat / voice: 同一Agent WebSocketと会話履歴を共有
- APIキー不要のCloudflare-hosted primary path

### LLM

- Primary: `@cf/openai/gpt-oss-120b`
- Fallback / reconciliation: `@cf/qwen/qwen3.8-27b`
- 外部事実が必要な質問は、検索結果と取得ページ本文を根拠として回答

### 日本語STT

- Realtime: `@cf/deepgram/nova-3`
- Accurate final: `@cf/openai/whisper-large-v3-turbo`
- Disagreement resolver: `@cf/qwen/qwen3.8-27b`
- 16 kHz mono PCM、40 ms chunk
- assistant音声の再入力抑制とbarge-in対応

### 日本語TTS

- Server primary: `@cf/myshell-ai/melotts`
- Server TTSが利用できない場合は、ブラウザーに存在する日本語 `SpeechSynthesis` voiceのみをfallbackとして使用
- 非日本語device voiceへのfallbackは禁止

### Web grounding

- Google HTML
- DuckDuckGo HTML
- Bing HTML
- 日本語Wikipedia
- Google News RSS
- 取得ページ本文のevidence抽出
- `@cf/baai/bge-reranker-base` によるreranking

## Web版

主なroute:

- `/` : チャット / 音声 / 画面共有UI
- `/health` : 基本稼働確認
- `/voice-health` : 現在のvoice revisionとモデル構成
- `/api/chat` : 文字会話API
- `/api/locate` : 共有画面から対象を特定するVision API
- `/api/model-smoke` : 現行primary LLMの実推論smoke test
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

ローカルWorkerと組み合わせる場合:

```bash
# terminal 1
npm install
npm run dev

# terminal 2
cd desktop
npm install
npm start
```

Production Workerの既定URLは `https://talksys.syouziroupc.workers.dev` です。別のWorkerへ接続する場合はデスクトップ版の接続設定、または `TALKSYS_API_BASE` を使用してください。

```powershell
$env:TALKSYS_API_BASE="https://example.workers.dev"
npm start
```

## 検証

```bash
npm install
npm test
npx wrangler deploy --dry-run
```

GitHub Actionsでは以下を実行します。

1. JavaScript syntax check
2. v14.1 architecture / API tests
3. Wrangler bundle dry-run
4. Web desktop / mobile screenshot rendering
5. Desktop control / overlay screenshot rendering
6. Production deployment
7. `/voice-health` の `cloudflare-live-v14.1` 一致確認

Productionが古いrevisionのまま、かつデプロイ認証情報が無い場合はworkflowを失敗させます。CIが緑なのに本番だけ古い状態を成功扱いしません。

## Cloudflare production deploy

GitHub Actionsからproductionへdeployする場合、Repository Secretsに以下が必要です。

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

API tokenはWorkerをdeployできる最小限のscopeに限定し、ソースコードへ保存しないでください。

Cloudflare Workers Buildsを利用する場合は、既存Worker `talksys` の Settings > Builds からこのGitHub repositoryを接続できます。Cloudflare側Worker名と `wrangler.jsonc` の `name` は一致させてください。

Temporary account (`wrangler deploy --temporary`) は認証なしのWorker previewには使えますが、Cloudflareがtemporary accountで明示している対応リソースにWorkers AIは含まれていません。Workers AIを使うTalkSysの最終E2E確認はpermanent Cloudflare account上で行ってください。

## 手動production deploy

Cloudflareへ認証済みの環境で:

```bash
npm install
npm run deploy
```

デプロイ後は最低限、以下を確認します。

```text
GET /voice-health
GET /api/model-smoke
GET /api/voice-smoke
WebSocket /agents/talk-sys-voice-agent/default
```
