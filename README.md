# TalkSys

Cloudflare Workers + Workers AI だけで動く、最小構成のAIチャットです。

## 構成

- `/` : チャット画面
- `/api/chat` : Workers AI への会話API
- `/health` : 稼働確認
- AIモデル: `@cf/meta/llama-3.1-8b-instruct-fast`

APIキーをソースコードへ埋め込む必要はありません。`wrangler.jsonc` の Workers AI binding (`AI`) を使います。

## Cloudflareへ接続

Cloudflare Dashboard → Workers & Pages → Create application → Import a repository から `syouziroupc/talksys` を選択してください。

Worker名は `talksys` のままにしてください。`wrangler.jsonc` の `name` とCloudflare側のWorker名が一致している必要があります。

設定は基本的に以下だけです。

- Production branch: `main`
- Build command: なし
- Deploy command: `npx wrangler deploy`

接続後は `main` へのpushで自動デプロイされます。

## ローカル確認

```bash
npm install
npm run dev
```

## 手動デプロイ

```bash
npm install
npm run deploy
```
