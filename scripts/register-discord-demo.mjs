const appId = process.env.DISCORD_APPLICATION_ID;
const guildId = process.env.DISCORD_TEST_GUILD_ID;
const token = process.env.DISCORD_TOKEN;

if (!appId || !guildId || !token) {
  console.error('DISCORD_APPLICATION_ID, DISCORD_TEST_GUILD_ID, DISCORD_TOKEN are required');
  process.exit(1);
}

const command = {
  name: 'talk',
  description: 'TalkSysに質問します',
  type: 1,
  options: [{
    name: 'question',
    description: '質問内容',
    type: 3,
    required: true,
  }],
};

const url = `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`;
const response = await fetch(url, {
  method: 'POST',
  headers: {
    authorization: `Bot ${token}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify(command),
});

const text = await response.text();
if (!response.ok) {
  console.error(`Discord command registration failed: ${response.status} ${text}`);
  process.exit(1);
}
console.log(text);
