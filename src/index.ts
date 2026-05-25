import { createServer } from "node:http";
import {
  ApplicationCommandOptionTypes,
  createBot,
  Intents,
  InteractionResponseTypes,
  InteractionTypes,
} from "discordeno";
import { config, formatCooldown } from "./config.js";
import {
  addRoleForReaction,
  ensurePostRole,
  getTrackedForumPostById,
  removeRoleForReaction,
  syncAllPostRoles,
  syncPostRoleForMessage,
} from "./forumPosts.js";

type CommandInteraction = {
  id: bigint;
  token: string;
  type: number;
  channelId?: bigint;
  guildId?: bigint;
  data?: {
    name?: string;
  };
  member?: {
    id?: bigint;
    roles: bigint[];
  };
  user?: {
    id: bigint;
  };
  respond: (
    response: string | Record<string, unknown>,
    options?: { isPrivate?: boolean; withResponse?: boolean },
  ) => Promise<unknown>;
  edit: (
    response: string | Record<string, unknown>,
    messageId?: bigint | string,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
};

type InteractionMessage = {
  content: string;
};

type RawGatewayPayload = {
  t?: string;
  d?: Record<string, unknown>;
};

const notifyCooldowns = new Map<bigint, number>();
const processedNotifyInteractions = new Map<bigint, number>();
const activeNotifyKeys = new Set<string>();
const recentPostPings = new Map<bigint, number>();
const postPingDedupMs = 15_000;

function cleanupProcessedInteractions(): void {
  const now = Date.now();

  for (const [interactionId, processedAt] of processedNotifyInteractions) {
    if (now - processedAt >= 15 * 60 * 1000) {
      processedNotifyInteractions.delete(interactionId);
    }
  }
}

function markInteractionProcessed(interactionId: bigint): void {
  processedNotifyInteractions.set(interactionId, Date.now());
}

function hasProcessedInteraction(interactionId: bigint): boolean {
  cleanupProcessedInteractions();
  return processedNotifyInteractions.has(interactionId);
}

function getActiveNotifyKey(postId: bigint): string {
  return `${postId}`;
}

function userCanNotify(interaction: CommandInteraction): boolean {
  const memberRoles = interaction.member?.roles ?? [];
  return memberRoles.includes(config.notifierRoleId);
}

function userBypassesCooldown(interaction: CommandInteraction): boolean {
  const memberRoles = interaction.member?.roles ?? [];
  return memberRoles.includes(config.adminRoleId);
}

function getInteractionUserId(interaction: CommandInteraction): bigint | undefined {
  return interaction.user?.id ?? interaction.member?.id;
}

function getCooldownRemaining(userId: bigint): number {
  const lastNotifyAt = notifyCooldowns.get(userId);

  if (lastNotifyAt === undefined) {
    return 0;
  }

  const expiresAt = lastNotifyAt + config.notifyCooldownMs;
  return Math.max(0, expiresAt - Date.now());
}

function setCooldown(userId: bigint): void {
  notifyCooldowns.set(userId, Date.now());
}

function cleanupCooldown(userId: bigint): void {
  const remaining = getCooldownRemaining(userId);

  if (remaining === 0) {
    notifyCooldowns.delete(userId);
  }
}

function cleanupRecentPostPings(): void {
  const now = Date.now();

  for (const [postId, lastPingAt] of recentPostPings) {
    if (now - lastPingAt >= postPingDedupMs) {
      recentPostPings.delete(postId);
    }
  }
}

function wasPostPingedRecently(postId: bigint): boolean {
  cleanupRecentPostPings();
  const lastPingAt = recentPostPings.get(postId);

  if (lastPingAt === undefined) {
    return false;
  }

  return Date.now() - lastPingAt < postPingDedupMs;
}

function markPostPinged(postId: bigint): void {
  recentPostPings.set(postId, Date.now());
}

async function safelyRespond(
  interaction: CommandInteraction,
  content: string,
): Promise<void> {
  try {
    const message: InteractionMessage = {
      content,
    };

    await interaction.respond(message, {
      isPrivate: true,
    });
  } catch (error) {
    console.error("Failed to respond to interaction:", error);
  }
}

async function safelyEditResponse(
  interaction: CommandInteraction,
  content: string,
): Promise<void> {
  try {
    const message: InteractionMessage = {
      content,
    };

    await interaction.edit(message);
  } catch (error) {
    console.error("Failed to edit interaction response:", error);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getBigIntField(
  payload: Record<string, unknown>,
  key: string,
): bigint | undefined {
  const value = payload[key];

  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "string" && value.length > 0) {
    return BigInt(value);
  }

  return undefined;
}

function getEmojiNameField(payload: Record<string, unknown>): string | undefined {
  const emoji = payload.emoji;

  if (typeof emoji !== "object" || emoji === null) {
    return undefined;
  }

  const name = (emoji as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

const notifyCommand = {
  name: "notify",
  description: "Ping the opt-in role for the current forum thread.",
};
const rawPort = process.env.PORT;
const shouldStartHttpServer = rawPort !== undefined && rawPort.length > 0;
const port = shouldStartHttpServer
  ? Number.parseInt(rawPort, 10)
  : undefined;

if (shouldStartHttpServer === true && (port === undefined || Number.isNaN(port) === true || port <= 0)) {
  throw new Error("PORT must be a valid positive number.");
}

const server = shouldStartHttpServer
  ? createServer((request, response) => {
    if (request.url === "/" || request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        ok: true,
        uptimeSeconds: Math.floor(process.uptime()),
      }));
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not Found");
  })
  : null;

const bot = createBot({
  token: config.token,
  intents:
    Intents.Guilds |
    Intents.GuildMembers |
    Intents.GuildMessages |
    Intents.GuildMessageReactions,
  desiredProperties: {
    channel: {
      id: true,
      parentId: true,
      name: true,
      messageId: true,
    },
    interaction: {
      id: true,
      token: true,
      type: true,
      channelId: true,
      guildId: true,
      data: true,
      member: true,
      user: true,
    },
    member: {
      id: true,
      roles: true,
      guildId: true,
    },
    role: {
      id: true,
      name: true,
    },
    user: {
      id: true,
      bot: true,
    },
  },
  events: {
    async ready(_, rawPayload) {
      console.log(`Connected to ${rawPayload.guilds.length} guild(s)!`);

      try {
        await bot.helpers.upsertGuildApplicationCommands(config.guildId, [
          notifyCommand,
        ]);
        await syncAllPostRoles(bot);
        console.log("Friendslopper is ready.");
      } catch (error) {
        console.error("Startup sync failed:", error);
      }
    },

    async raw(data) {
      const payload = data as RawGatewayPayload;

      try {
        if (payload.t === undefined || payload.d === undefined) {
          return;
        }

        if (
          payload.t !== "MESSAGE_REACTION_ADD" &&
          payload.t !== "MESSAGE_REACTION_REMOVE" &&
          payload.t !== "MESSAGE_REACTION_REMOVE_ALL" &&
          payload.t !== "MESSAGE_REACTION_REMOVE_EMOJI"
        ) {
          return;
        }

        const guildId = getBigIntField(payload.d, "guild_id");
        const channelId = getBigIntField(payload.d, "channel_id");
        const messageId = getBigIntField(payload.d, "message_id");

        if (guildId !== config.guildId || channelId === undefined || messageId === undefined) {
          return;
        }

        if (payload.t === "MESSAGE_REACTION_REMOVE_ALL") {
          await syncPostRoleForMessage(bot, channelId, messageId);
          return;
        }

        const emojiName = getEmojiNameField(payload.d);
        if (emojiName !== config.reactionEmoji) {
          return;
        }

        if (payload.t === "MESSAGE_REACTION_REMOVE_EMOJI") {
          await syncPostRoleForMessage(bot, channelId, messageId);
          return;
        }

        const userId = getBigIntField(payload.d, "user_id");
        if (userId === undefined) {
          return;
        }

        if (payload.t === "MESSAGE_REACTION_ADD") {
          await addRoleForReaction(bot, channelId, messageId, userId);
          return;
        }

        if (payload.t === "MESSAGE_REACTION_REMOVE") {
          await removeRoleForReaction(bot, channelId, messageId, userId);
        }
      } catch (error) {
        console.error("raw reaction event failed:", error);
      }
    },

    async interactionCreate(rawInteraction) {
      const interaction = rawInteraction as unknown as CommandInteraction;

      try {
        if (interaction.data?.name !== "notify") {
          return;
        }

        if (interaction.type !== InteractionTypes.ApplicationCommand) {
          return;
        }

        if (interaction.guildId !== config.guildId) {
          await safelyRespond(interaction, "This command only works in the target guild.");
          return;
        }

        const userId = getInteractionUserId(interaction);
        if (userId === undefined) {
          await safelyRespond(interaction, "I couldn't figure out who ran that command.");
          return;
        }

        if (userCanNotify(interaction) === false) {
          await safelyRespond(
            interaction,
            "You need the configured notifier role to use `/notify`.",
          );
          return;
        }

        if (userBypassesCooldown(interaction) === false) {
          cleanupCooldown(userId);

          const remainingCooldown = getCooldownRemaining(userId);
          if (remainingCooldown > 0) {
            await safelyRespond(
              interaction,
              `You're on cooldown for another ${formatCooldown(remainingCooldown)}.`,
            );
            return;
          }
        }

        if (interaction.channelId === undefined) {
          await safelyRespond(interaction, "I couldn't figure out which thread this was run in.");
          return;
        }

        const post = await getTrackedForumPostById(bot, interaction.channelId);
        if (post === null) {
          await safelyRespond(
            interaction,
            "This command only works inside one of the tracked game threads.",
          );
          return;
        }

        if (hasProcessedInteraction(interaction.id) === true) {
          return;
        }

        if (wasPostPingedRecently(post.id) === true) {
          await safelyRespond(
            interaction,
            `A ping for ${post.name} was already sent very recently.`,
          );
          return;
        }

        const activeNotifyKey = getActiveNotifyKey(post.id);
        if (activeNotifyKeys.has(activeNotifyKey) === true) {
          await safelyRespond(
            interaction,
            `A ping for ${post.name} is already being sent.`,
          );
          return;
        }

        activeNotifyKeys.add(activeNotifyKey);

        try {
          markInteractionProcessed(interaction.id);

          if (userBypassesCooldown(interaction) === false) {
            setCooldown(userId);
          }

          await safelyRespond(
            interaction,
            `${config.loadingEmoji} Sending ping for ${post.name}...`,
          );

          await delay(3_000);

          const role = await ensurePostRole(bot, post);

          await bot.helpers.sendMessage(post.id, {
            content: `${post.pingEmoji} <@&${role.id}> Heads up for ${post.name}.`,
          });
          markPostPinged(post.id);

          await safelyEditResponse(
            interaction,
            `${config.checkmarkEmoji} Sent ping for ${post.name}!`,
          );
        } catch (error) {
          processedNotifyInteractions.delete(interaction.id);

          if (userBypassesCooldown(interaction) === false) {
            notifyCooldowns.delete(userId);
          }

          throw error;
        } finally {
          activeNotifyKeys.delete(activeNotifyKey);
        }
      } catch (error) {
        console.error("interactionCreate failed:", error);

        if (interaction.type === InteractionTypes.ApplicationCommand) {
          await safelyRespond(
            interaction,
            "Something went wrong while handling `/notify`.",
          );
        }
      }
    },
  },
});

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown === true) {
    return;
  }

  isShuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);

  const forceExitTimeout = setTimeout(() => {
    console.error("Graceful shutdown timed out.");
    process.exit(1);
  }, 10_000);

  forceExitTimeout.unref();

  try {
    if (server !== null) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }

    await Promise.resolve(bot.shutdown?.());
    process.exit(0);
  } catch (error) {
    console.error("Shutdown failed:", error);
    process.exit(1);
  }
}

server?.on("error", (error) => {
  console.error("HTTP server failed:", error);
  process.exit(1);
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

if (server !== null && port !== undefined) {
  server.listen(port, "0.0.0.0", () => {
    console.log(`Health server listening on 0.0.0.0:${port}`);
  });
}

bot.start();
