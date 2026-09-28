# TalkSys

TalkSys は Cloudflare Workers / Workers AI 上で動作する日本語対話アシスタントです。現行構成は **Web・Discord・電話入口で同じ TalkSys 回答経路を共有する統合ランタイム**です。電話番号の開通に依存しないデモ経路として、Web音声の固定入口も提供します。

- production entry: `src/integrated-entry.js`
- shared answer boundary: `src/entry.js`
- Telnyx adapter: `src/telephony/index.js`
- fallback channel revision: `talksys-v109-fallback-voice-entry-r1`
- production URL: `https://talksys.syouziroupc.workers.dev`

> バージョン付きファイル名は移行履歴を含みます。新しい実装を追加する前に `architecture/capabilities.json` を確認し、既存の canonical capability を拡張してください。

## 現行アーキテクチャ

`wrangler.jsonc` の active entry は `src/integrated-entry.js` です。Telnyx固有の着信・音声ストリームだけを `src/telephony/index.js` へ振り分け、通常のWeb/API要求と電話の確定テキストは既存の共通 TalkSys 回答経路へ合流します。電話機能はコード上統合済みですが、`TELEPHONY_ENABLED=false` が既定で、番号・実運用設定が揃うまで無効です。

主な production capability は `architecture/capabilities.json` で管理しています。

| Capability | Canonical source | 状態 |
| --- | --- | --- |
| Runtime / channel routing | `src/integrated-entry.js` | production |
| Answer authorization | `src/entry.js` | production |
| Telnyx intake | `src/telephony/index.js` | production / disabled by default |
| Grounding policy / answer synthesis | `src/worker-v44.js` | production |
| Search execution / planning / evidence validation | `src/search-v45.js` | production |
| Structured/free API tools | `src/free-api-tools-v45.js` | production |
| Speech-to-text | `src/stt-v45.js` | production |
| Web UI | `src/ui-v45.js` | production |

## ターン処理

`POST /api/turn` は入力を正規化したうえで、ターンを次の経路へ振り分けます。

- **deterministic**: 四則演算、日付などローカルで確定できる処理
- **clarify**: 根拠なく対象を特定できない曖昧入力
- **casual**: 雑談・感情表現など、外部取得を必要としない会話
- **external**: 現在情報、価格、在庫、天気、制度、検索依存質問など

外部事実が必要なターンでは、構造化APIを先に並列実行し、質問全体を満たせない場合に Web retrieval を補助的に使います。回答生成の主モデルは `@cf/zai-org/glm-5.3-flash`、検索計画には `@cf/qwen/qwen3-30b-a3b-fp8` を使用します。

検索・grounding は以下を重視します。

- API-first + Web supplement
- assistant の過去発話を factual evidence として再利用しない
- query/result relevance gate
- authority check after relevance
- direct primary source resolver
- partial evidence answering
- retrieval failure 時の fail-close
- current price / stock / timetable / version 等を根拠なしで断定しない

## V46 hard-facts truth gate

`src/entry.js` は `/api/turn` の JSON 応答を最終段で再検査します。

### 交通経路

具体的な乗換駅・列車名・路線・時刻の列挙は、`transit_route` 等の**構造化された経路根拠**がある場合だけ許可します。一般Web検索の snippet や prose evidence だけでは、具体的な経路シーケンスを認可しません。

構造化根拠がない状態で exact route claim が生成された場合は削除し、必要に応じて次の fail-close 応答へ置換します。

```text
具体的な乗換駅・列車名・時刻は、構造化された経路根拠が確認できた場合だけ案内します。
```

### 動的な具体値

最新・現在・今日・価格・在庫・時刻表・法律・天気・為替・バージョン等の質問で usable external evidence がない場合、モデルが新しく作った価格、時刻、割合、バージョン番号、型番風識別子を終端で除去します。

一方、ユーザー自身が入力した具体値は会話上の前提として再利用できます。

## 音声入力

現在の browser voice path は **HTTP turn + client-side adaptive VAD** です。旧 WebSocket / Agent / Durable Object voice path は production では使用していません。

- client revision: `talksys-v45-http-adaptive-vad`
- transcription endpoint: `POST /api/transcribe`
- turn endpoint: `POST /api/turn`
- STT model: `@cf/openai/whisper-large-v3-turbo`
- STT revision: `talksys-v45-hardened-whisper`
- adaptive noise VAD / ambient calibration
- weak-speech rejection
- common STT hallucination rejection

## 主な production route

| Method | Route | 用途 |
| --- | --- | --- |
| `GET` | `/` | 現行 Web UI |
| `GET` | `/call` | 電話番号不要の固定 Web 音声入口 |
| `GET` | `/line-voice` | LINE等からリンクで開く同一 Web 音声入口 |
| `GET` | `/channel-health` | Web / LINEリンク / Telnyx / Discord の入口状態 |
| `GET` | `/talk-v45.js` | 現行ブラウザ音声/会話クライアント |
| `GET` | `/voice-health` | runtime / voice / search / STT 構成の確認 |
| `GET` | `/truth-gate-health` | 回答境界の状態確認 |
| `GET` | `/telephony-health` | Telnyx電話連携の状態確認 |
| `POST` | `/api/transcribe` | 音声認識 |
| `POST` | `/api/plan` | ターン分類・調査計画の確認 |
| `POST` | `/api/turn` | 統合会話ターン |

Telnyx電話アダプターは統合済みですが、既定値は `TELEPHONY_ENABLED=false` です。番号が間に合わない場合は `/call` または `/line-voice` を使用し、別のAI/STT/TTS実装を増やさず既存Web音声経路へ合流させます。`/line-voice` はLINE Callの音声媒体APIではなく、LINE等から共有できるWeb音声入口です。

## 検索・構造化データ

現行 worker は free/structured API router と Web retrieval を組み合わせます。`/voice-health` では、API-first、parallel API execution、multi-engine Web retrieval、direct-primary resolver、research state machine などの稼働状態を確認できます。

検索実装を変更するときは、原則として以下の canonical source を拡張します。

- `src/search-v45.js`
- `src/free-api-tools-v45.js`
- `src/free-api-knowledge-v45.js`
- `src/free-api-knowledge-extra-v45.js`
- `src/free-shopping-api-v45.js`

過去実装は prior art として残っていますが、`architecture/capabilities.json` で `legacyPriorArt` とされたファイルを新しい production entry として復活させないでください。

## ローカル検証

```bash
npm install
npm run architecture:check
npm run architecture:graph
npm test
npx wrangler deploy --dry-run
```

`npm test` は `tests/*.test.mjs` を実行します。production entry と architecture registry の不一致、active source graph の破壊、既存回帰契約の破壊は merge 前に検出する方針です。

## Production deploy

通常の `main` push だけでは production deploy は発火しません。`.github/workflows/deploy.yml` は次の場合に実行されます。

- `workflow_dispatch`
- `main` の `.deploy/production-trigger.txt` が変更されたとき

deploy workflow は exact revision の validation 成功を確認したあと、再度テストと Wrangler dry-run を行い、その revision を Cloudflare Workers へ deploy します。

GitHub Actions から直接 deploy するには、利用可能な Cloudflare credential が必要です。credential はソースコードへ保存しません。

## Production verification

最低限、次を確認します。

```text
GET  /truth-gate-health
GET  /channel-health
GET  /voice-health
POST /api/turn        # deterministic smoke
POST /api/turn        # grounded/current-fact smoke
POST /api/transcribe  # voice path smoke when audio fixture is available
```

V46 の production verification では、少なくとも次の回帰を確認します。

- 架空商品の現在価格を捏造しない
- 構造化経路根拠なしに列車時刻・乗換シーケンスを断定しない
- 既知の危険な交通経路 hallucination を遮断する
- ユーザー提示の具体値は不必要に消さない
- 通常の雑談を truth gate で過剰遮断しない
