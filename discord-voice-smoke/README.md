# TalkSys Discord Voice Smoke

面談用の暫定音声疎通試験です。長期運用用ではありません。

## 試験経路

Discord VC -> Opus -> PCM 48k stereo -> PCM 16k mono -> TalkSys `/api/realtime-stt` WebSocket -> `/api/turn` -> TalkSys TTS `/api/voice/synthesize` -> Discord VC

Discord側ではTTSしません。返送音声はTalkSys側で生成したMP3です。

## 必要なDiscord Bot権限

- View Channels
- Connect
- Speak

Botはサーバーに追加済みである必要があります。Message Content Intentは不要です。

## TalkSys側

面談用の一時デモでは `DISCORD_BRIDGE_TOKEN` は不要です。2026-09-18 17:00 JST まではTalkSys本番Workerが一時デモヘッダーを受け付け、TalkSys側で生成したTTS音声を返します。

期限後はこの一時経路は自動で無効になり、恒久運用では `DISCORD_BRIDGE_TOKEN` を使います。

## 起動

Windowsでは `start.ps1` を実行してください。Node.js 22.12以上を確認し、依存関係を自動導入したうえで、未設定のDiscord値だけ対話入力します。

```powershell
cd discord-voice-smoke
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

必要なのはDiscord側で取得する次の3項目です。

- `DISCORD_TOKEN`
- `DISCORD_GUILD_ID`
- `DISCORD_VOICE_CHANNEL_ID`

TalkSys側URL、STT WebSocket、`/api/turn`、TalkSys TTS、raw echo fallbackはコード側に設定済みです。

起動後、自動で指定VCへ参加します。人が話すと受信した実音声をTalkSysのリアルタイムSTT WebSocketへ送り、認識結果を `/api/turn` へ渡します。回答はTalkSys側TTSでMP3化してVCへ返します。TTSが失敗した場合だけ、受信した実音声をそのまま返すraw echoへフォールバックします。

## 合格条件

コンソールで次の順に確認します。

```
[discord] voice ready
[preflight] realtime STT websocket open
[rx] user=...
[stt] websocket open
[stt] ...
[turn] ...
[tts] ... bytes
[tx] playback started
```

再接続、多人数同時発話、長時間安定性は対象外です。
