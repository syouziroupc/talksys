# TalkSys

Cloudflare Workers + Workers AI をバックエンドにした、音声会話・画面案内対応のシンプルなAI会話システムです。

## Web版

- `/` : チャット画面
- `/api/chat` : Workers AI への会話API
- `/api/locate` : 共有画面から操作対象を探し、0〜1000の正規化座標を返すVision API
- `/health` : 稼働確認
- 会話モデル: `@cf/meta/llama-3.1-8b-instruct-fast`
- 画面認識モデル: `@cf/meta/llama-3.2-11b-vision-instruct`
- 音声入力・読み上げ
- ブラウザーの画面共有
- 共有画面プレビュー上への自動矢印・手動矢印
- PNGデスクトップキャプチャー

APIキーをソースコードへ埋め込む必要はありません。`wrangler.jsonc` の Workers AI binding (`AI`) を使います。

## Windows / Desktop Companion

`desktop/` はElectron製の薄いデスクトップ版です。Web版と違い、AIが見つけた位置へ **実際のデスクトップ上に透明な常時最前面オーバーレイ** を表示できます。

- プライマリ画面を静止画キャプチャー
- 操作案内が必要な発言で `/api/locate` を呼び出す
- AIが返した座標へ赤い矢印と円を表示
- オーバーレイはマウスクリックを下のアプリへ通す
- PNGスクリーンショット保存
- 会話、音声入力、回答読み上げ

ローカルWorkerと組み合わせる場合:

```bash
# ターミナル1: Worker
npm install
npm run dev

# ターミナル2: Desktop Companion
cd desktop
npm install
npm start
```

Cloudflareへデプロイ後は、デスクトップ版の「接続設定」にWorker URLを入力するか、起動前に `TALKSYS_API_BASE` を設定してください。

PowerShell例:

```powershell
$env:TALKSYS_API_BASE="https://talksys.<your-subdomain>.workers.dev"
npm start
```

## Cloudflareへ接続

GitHub Actionsからの自動デプロイにはRepository Secretsとして以下が必要です。

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Worker名は `talksys` のままにしてください。`wrangler.jsonc` の `name` とCloudflare側のWorker名が一致している必要があります。

Llama 3.2 Visionを初めて使うCloudflareアカウントでは、MetaのライセンスとAcceptable Use Policyへの同意が必要です。

## ローカルWeb確認

```bash
npm install
npm run dev
```

## 手動デプロイ

```bash
npm install
npm run deploy
```
