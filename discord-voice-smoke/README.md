# TalkSys Discord Voice Adapter

Discord音声をWeb版TalkSysへ接続するための薄い入出力アダプターです。

## 現在の経路

```
Discord VC
  -> Opus
  -> 48 kHz stereo PCM
  -> 90 Hz high-pass + 16 kHz mono PCM
  -> Web互換発話区間判定
  -> WAV
  -> POST /api/transcribe
  -> Whisper Large v3 Turbo
  -> POST /api/turn
  -> 共通TalkSys回答
  -> POST /api/voice/synthesize
  -> Discord VC
```

Discord固有処理は、Discord音声の受信・PCM変換と、TalkSys音声のDiscord再生だけです。

## 音声認識

確定文字起こしは毎回 `/api/transcribe` を使用します。Discord bridge内にRealtime STTの確定経路、Whisper fallback、STT投票、circuit breakerはありません。

発話区間はWeb版と同じ基準へ合わせています。

- 16 kHz mono
- 650 ms 無音で発話終了
- 260 ms 最短発話
- 8フレーム pre-roll
- adaptive noise floor
- RMS / peak / SNR 開始判定
- 90 Hz high-pass
- 1600 ms Discord無音判定はtransport safetyのみ

Whisperのタイムアウトは30秒です。数百msの短縮より認識品質を優先します。

## 回答

確定Whisper transcriptをそのまま `/api/turn` へ渡します。Discord専用のGeminiプロンプト、検索ルール、verification、回答短縮はありません。会話履歴、`previousInteractionId`、検索文脈もWeb版と同じ形式で渡します。

検索案内などの待ち時間音声は回答とは別系統です。本回答が完成した時点で待ち音声を停止し、本回答TTSを優先します。

## 監視

各発話に1つの `utteranceId` を付け、以下をCloudflareのログ・Analytics Engine・conversation logsへ関連付けます。

- Discord受信開始
- 最初のPCM
- 発話終了
- WAV完成
- `/api/transcribe`開始
- Whisper完了
- confirmed transcript
- `/api/turn`開始
- primary / verifier / 最終回答
- TTS開始 / 終了
- Discord再生開始
- pipeline完了

`realtimeTranscript`、`confirmedTranscript`、`geminiInputText`も保存できる契約です。現在DiscordではNovaを使わないため、`realtimeTranscript`は空で、`confirmedTranscript`と`geminiInputText`が一致します。

## 必要なDiscord Bot権限

- View Channels
- Connect
- Speak
- Use Application Commands

Message Content Intentは不要です。

## 初回セットアップ

```powershell
cd discord-voice-smoke
powershell -ExecutionPolicy Bypass -File .\setup-bridge-secret.ps1
```

この処理はCloudflareの `DISCORD_BRIDGE_TOKEN` とローカルの同一トークンを作成し、ローカル側はWindows DPAPIで保存します。

## 起動

通常はリポジトリの `main` で次を実行します。

```powershell
cd discord-voice-smoke
powershell -ExecutionPolicy Bypass -File .\update-and-start.ps1
```

必要な値は次だけです。

- `DISCORD_TOKEN`
- `DISCORD_BRIDGE_TOKEN`

`TALKSYS_BASE_URL` は省略時にproduction URLを使います。サーバーIDやVC IDの手入力は不要です。

利用者がVCへ参加して `/talksys` を実行するとBotが同じVCへ参加します。`/leave` で退出します。

## 実音声の合格確認

最低限、普通の声、小さい声、途中に自然な間を入れた発話、長めの発話、短い発話を試します。確認対象は速度より先に次の一致です。

1. Web版Whisper transcript
2. Discord版Whisper transcript
3. Geminiへ渡したtext
4. 最終回答

コンソールでは概ね次の順序になります。

```
[discord] voice ready
[capture] finalized ...
[stt] confirmed Whisper start ...
[stt] confirmed model=...
[turn] user: ...
[turn] assistant: ...
[tts] ...
[tx] playback started
[latency-summary] ...
[metrics] voice latency persisted
```
