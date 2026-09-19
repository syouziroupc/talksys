# TalkSys Discord Voice Smoke

面談用の暫定音声疎通試験です。長期運用用ではありません。

## 試験経路

Discord VC -> Opus -> PCM 48k stereo -> PCM 16k mono -> TalkSys `/api/realtime-stt` WebSocket -> `/api/turn` -> TalkSys TTS `/api/voice/synthesize` -> Discord VC

Discord側ではTTSしません。返送音声はTalkSys側で生成したMP3です。

## 必要なDiscord Bot権限

- View Channels
- Connect
- Speak
- Use Application Commands

Botはサーバーに追加済みである必要があります。Message Content Intentは不要です。既存招待に application commands 権限が無い場合は、Discord Developer Portal からBotを再招待してください。

## TalkSys側

Discord返答音声は恒久運用の `DISCORD_BRIDGE_TOKEN` で認証します。期限付きデモヘッダーは廃止済みです。

`start.ps1` は環境変数にトークンが無い場合だけ安全入力を求めます。トークンをチャットやログへ貼り付ける必要はありません。

## 起動

Windowsでは `start.ps1` を実行してください。Node.js 22.12以上を確認し、依存関係を自動導入したうえで、未設定のDiscord値だけ対話入力します。

```powershell
cd discord-voice-smoke
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

起動時に必要なのは次の3項目です。

- `DISCORD_TOKEN`
- `DISCORD_GUILD_ID`
- `DISCORD_BRIDGE_TOKEN`

`DISCORD_VOICE_CHANNEL_ID` は任意です。設定した場合だけ起動直後にそのVCへ自動参加します。通常は不要です。

TalkSys側URL、STT WebSocket、`/api/turn`、TalkSys TTS、raw echo fallbackはコード側に設定済みです。

起動後、Botは `/talksys` と `/leave` を対象サーバーへ登録します。利用者がVCに参加した状態で `/talksys` を実行すると、そのVCへBotが参加します。`/leave` で退出します。人が話すと受信した実音声をTalkSysのリアルタイムSTT WebSocketへ送り、認識結果を `/api/turn` へ渡します。回答はTalkSys側TTSでMP3化してVCへ返します。TTSなど後段が失敗した場合は、受信した実音声をそのまま返すraw echoへフォールバックします。STTが文字を返さない場合もraw echoを行い、Discord受信自体が成立しているか切り分けできます。

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
