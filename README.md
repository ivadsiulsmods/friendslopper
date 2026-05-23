# friendslopper

Discordeno bot for forum-based game pings in the WEBM.CLUB guild.

## Setup

```bash
bun install
```

Create `.env` with:

```bash
DISCORD_TOKEN=your_existing_bot_token
```

## Run

```bash
bun run start
```

The bot watches forum channel `1507096852976373760`, keeps `{POST TITLE} PING`
roles in sync with `:video_game:` reactions, and exposes `/notify`.
