# TalkSys Discord Voice Smoke

面談用の暫定音声疎通試験です。長期運用用ではありません。

## 試験経路

Discord VC -> Opus -> PCM 48k stereo -> PCM 16k mono -> TalkSys STT (Realtime WebSocket再利用 / 429時は `/api/transcribe`) -> `/api/turn-stream` (障害時 `/api/turn`) -> 文単位 `/api/voice/synthesize` -> Discord VC

Discord側ではTTSしません。返送音声はTalkSys側で生成した音声です。

## 必要なDiscord Bot権限

- View Channels
- Connect
- Speak
- Use Application Commands

Botはサーバーに追加済みである必要があります。Message Content Intentは不要です。既存招待に application commands 権限が無い場合は、Discord Developer Portal からBotを再招待してください。

## TalkSys側

Discord返答音声は恒久運用の `DISCORD_BRIDGE_TOKEN` で認証します。期限付きデモヘッダーは廃止済みです。

`start.ps1` は環境変数にトークンが無い場合だけ安全入力を求めます。トークンをチャットやログへ貼り付ける必要はありません。

## 初回セットアップ

Cloudflareの `DISCORD_BRIDGE_TOKEN` とローカル側の同一トークンは、手入力せず次で一度だけ作成できます。

```powershell
cd discord-voice-smoke
powershell -ExecutionPolicy Bypass -File .\setup-bridge-secret.ps1
```

32byteのランダム値を生成し、Cloudflare Worker Secretへ登録したうえで、同じ値をWindows DPAPIで暗号化して `%LOCALAPPDATA%\TalkSys` に保存します。平文トークンを表示・リポジトリ保存しません。

## 起動

通常は `update-and-start.ps1` を実行してください。ローカル変更が無いことを確認して `origin/main` へfast-forward更新した後、`start.ps1` を起動します。これにより、古いDiscordブリッジを誤って試験することを防ぎます。Node.js 22.12以上を確認し、依存関係を自動導入します。Discord Bot Tokenは初回入力後にWindows DPAPIで保存するため、2回目以降は通常そのまま起動できます。

```powershell
cd discord-voice-smoke
powershell -ExecutionPolicy Bypass -File .\update-and-start.ps1
```

起動時に必要なのは次の2項目です。

- `DISCORD_TOKEN`
- `DISCORD_BRIDGE_TOKEN`

`DISCORD_BRIDGE_TOKEN` は初回セットアップで自動保存されるため、実際にユーザーが入力するのはDiscord Bot Tokenだけです。サーバーIDやVC IDは不要です。

TalkSys側URL、STT WebSocket、`/api/turn-stream`、TalkSys TTSはコード側に設定済みです。診断用raw echoは廃止し、ユーザー音声をVCへ返しません。

起動後、Botが参加しているDiscordサーバーを自動検出し、既存の他コマンドを削除せず、`/talksys` と `/leave` だけを作成・更新します。利用者がVCに参加した状態で `/talksys` を実行すると、そのVCへBotが参加します。接続時の試験発声や検索案内TTSは行いません。`/leave` で退出します。人が話すと受信音声をSTTへ送り、認識結果を `/api/turn-stream` へ渡し、検証済み回答を文単位でTalkSys側TTSへ先行投入してVCへ返します。STTやTTSが失敗しても本人の音声をオウム返しせず、ログへ失敗箇所を出します。フォーンズが回答生成・再生中でも受音を止めず、次の発話は最大3件まで順番待ちに入れます。/talksys 実行者の受音ストリームは接続直後に先行して準備し、話し始めの取りこぼしを減らします。

## 合格条件

コンソールで次の順に確認します。

```
[discord] voice ready
[rx] user=...
[stt] websocket open user=... reusable=true
[stt] websocket reuse user=... state=1
[stt] ...
[turn-stream] ...
[latency] first-audio-ready=...ms source=verifier-stream
[tts] ... bytes
[tx] playback started
[metrics] voice latency persisted
```

再接続、多人数同時発話、長時間安定性は対象外です。
