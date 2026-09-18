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

Cloudflare Workerに次のsecretを設定してデプロイします。

```
npx wrangler secret put DISCORD_BRIDGE_TOKEN
```

値はローカルの `DISCORD_BRIDGE_TOKEN` と同じにします。

## 起動

PowerShell例:

```powershell
cd discord-voice-smoke
npm install
$env:DISCORD_TOKEN="..."
$env:DISCORD_GUILD_ID="..."
$env:DISCORD_VOICE_CHANNEL_ID="..."
$env:TALKSYS_BASE_URL="https://talksys.syouziroupc.workers.dev"
$env:DISCORD_BRIDGE_TOKEN="..."
npm start
```

起動後、自動で指定VCへ参加します。人が話すと受信した実音声をTalkSysのリアルタイムSTT WebSocketへ送り、認識結果を `/api/turn` へ渡します。回答はTalkSys側TTSで生成し、その音声をVCへ返します。

## 合格条件

コンソールで次の順に確認します。

```
[discord] voice ready
[rx] user=...
[stt] websocket open
[stt] ...
[turn] ...
[tts] ... bytes
[tx] playback started
```

再接続、多人数同時発話、長時間安定性は対象外です。
