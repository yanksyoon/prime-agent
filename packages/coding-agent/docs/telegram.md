# Telegram integration

Prime Agent can run as a Telegram bot through the same persistent background service used by the terminal UI. Each direct message, group, or forum topic maps to its own durable Prime Agent session.

## Set up the bot

1. Open the official [@BotFather](https://t.me/BotFather) account.
2. Send `/newbot`, choose a display name and a unique username ending in `bot`, and keep the returned token private.
3. To restrict access, message [@userinfobot](https://t.me/userinfobot) and note your numeric user ID.
4. Run the interactive setup:

```bash
prime-agent gateway setup
```

The wizard validates the token, asks for comma-separated allowed user IDs, and optionally saves a home channel for future notification delivery. Configuration is stored with mode `0600` in `~/.prime/agent/telegram.json` (or the configured Prime Agent directory). Run the wizard again to reconfigure it. If a token is exposed, revoke it immediately with BotFather's `/revoke` command.

## Run the gateway

```bash
prime-agent gateway
# equivalent:
prime-agent gateway run
```

The gateway runs in the foreground and stops cleanly on Ctrl+C. It starts or connects to the normal Prime Agent daemon, so Telegram sessions remain visible in `prime-agent agents`. Check configuration and Telegram connectivity with:

```bash
prime-agent gateway status
```

## Chat UX

Send text to the bot as you would in the terminal. The bot replies with an editable `Thinking…` status message and replaces it with the final answer. Long replies are split safely. Supported bot commands are:

- `/new` or `/reset` — start a fresh session for this chat/topic
- `/status` — show the session state
- `/stop` — abort the current turn
- `/sethome` — save the current chat as the future notification home channel
- `/whoami` — show numeric user and chat IDs
- `/help` — show help

Messages in the same chat/topic are processed in order; different chats can run concurrently. Telegram forum topics have separate sessions. In groups, the bot responds only when its `@username` is mentioned by default. BotFather privacy mode may prevent a bot from seeing normal group messages; disable Group Privacy and re-add the bot, or make it an administrator, if needed.

## Security and current scope

The bot has access to the same tools as Prime Agent. Configure an allowlist for any bot reachable by others. With an allowlist, unauthorized updates are silently ignored. Open access requires a separate explicit confirmation and should only be used for a private/testing bot. Missing or malformed access settings fail closed.

This initial integration accepts text and captions. Voice notes and file/image downloads are not yet forwarded. Transport uses Telegram long polling; webhook and background service installation are not yet provided. The bot token is redacted from surfaced transport errors.
