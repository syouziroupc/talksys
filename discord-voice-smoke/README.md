# TalkSys Discord Voice Adapter

`v107-web-parity` では `TALKSYS_WEB_UNIFIED=1`（既定）として、確定STTだけでなく高速相槌と検索案内の判定もWeb/Worker側へ統一します。Discord側では意味判断を行わず、音声transport、再生、barge-in、echo guard、観測のみを担当します。従来v105は `archive/discord-v105` ブランチに固定しています。

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

Discord固有処理は、Discordのspeaking gateで受けた音声の受信・48kHz stereo→16kHz mono変換・90Hz HPFと、TalkSys音声のDiscord再生だけです。ブラウザ用RMS/SNR VADはDiscord側では再適用しません。

## Web版との一致方針

- 高速相槌の可否・文言はDiscordローカルで決めず、共通 `/api/fast-reaction` を使用します。
- 検索案内は高速相槌とは独立して共通 `/api/search-preface` を並列実行します。
- 確定STTは共通 `/api/transcribe`、回答は共通 `/api/turn` を使用します。
- Discord固有の意味補正、検索判断、回答生成は行いません。
- freeze対策としてHTTP予算、AbortController、再生開始/完了タイムアウト、Gateway/Voice再接続監視は残します。これらはtransport安全策であり、回答内容には介入しません。

## 音声認識

確定文字起こしは毎回 `/api/transcribe` を使用します。Web版と同じく `/api/realtime-stt` のNova-3は暫定文字列から `/api/fast-reaction` を呼ぶ高速相槌専用で、Novaの文字列をTalkSys回答へ渡しません。Whisper fallback、STT投票、circuit breakerはありません。

発話区間はWeb版と同じ基準へ合わせています。

- 16 kHz mono
- 650 ms 無音で発話終了
- 260 ms 最短発話
- 8フレーム pre-roll
- adaptive noise floor
- RMS / peak / SNR 開始判定
- 90 Hz high-pass
- 発話区間はDiscord transport側を基準にし、最後のPCMから650 msで確定します。1600 ms Discord無音判定はtransport safetyのみです。

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

`realtimeTranscript`、`confirmedTranscript`、`geminiInputText`も保存できる契約です。DiscordでもWeb版と同じくNova-3は高速相槌の補助にだけ使います。回答本文は常にWhisper確定transcriptを基準にし、Novaの文字列で上書きしません。

## 必要なDiscord Bot権限

- View Channels
- Send Messages（起動・通話ライブログ表示用）
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

`/logs` を実行すると、そのテキストチャンネルに1つのライブログメッセージを表示し、起動状態、Realtime STT補助接続、Whisper、回答、TTS、主要レイテンシ、エラーを更新表示します。`/talksys` 実行時にも同じチャンネルへ自動的にライブログを表示します。

## 実音声の合格確認

最低限、普通の声、小さい声、途中に自然な間を入れた発話、長めの発話、短い発話を試します。確認対象は速度より先に次の一致です。

1. Web版Whisper transcript
2. Discord transport-gated PCM → Whisper transcript
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
