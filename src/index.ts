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
  getAutocompleteMatches,
  getTrackedForumPostByName,
  getTrackedForumPosts,
  removeRoleForReaction,
  shouldProcessReactionPayload,
  syncAllPostRoles,
  syncPostRoleForMessage,
} from "./forumPosts.js";

type CommandInteraction = {
  id: bigint;
  token: string;
  type: number;
  guildId?: bigint;
  data?: {
    name?: string;
    options?: Array<{
      name: string;
      value?: string | number | boolean;
      focused?: boolean;
    }>;
  };
  member?: {
    roles: bigint[];
  };
  user?: {
    id: bigint;
  };
  respond: (
    response: string | Record<string, unknown>,
    options?: { isPrivate?: boolean; withResponse?: boolean },
  ) => Promise<unknown>;
};

const notifyCooldowns = new Map<bigint, number>();

function getOptionValue(
  interaction: CommandInteraction,
  optionName: string,
): string | number | boolean | undefined {
  const options = interaction.data?.options ?? [];

  for (const option of options) {
    if (option.name === optionName) {
      return option.value;
    }
  }

  return undefined;
}

function getFocusedOptionValue(interaction: CommandInteraction): string {
  const options = interaction.data?.options ?? [];

  for (const option of options) {
    if (option.focused === true && typeof option.value === "string") {
      return option.value;
    }
  }

  return "";
}

function userCanNotify(interaction: CommandInteraction): boolean {
  const memberRoles = interaction.member?.roles ?? [];
  return memberRoles.includes(config.notifierRoleId);
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

async function safelyRespond(
  interaction: CommandInteraction,
  content: string,
): Promise<void> {
  try {
    await interaction.respond(content, {
      isPrivate: true,
    });
  } catch (error) {
    console.error("Failed to respond to interaction:", error);
  }
}

const notifyCommand = {
  name: "notify",
  description: "Ping the opt-in role for a forum game post.",
  options: [
    {
      type: ApplicationCommandOptionTypes.String,
      name: "game",
      description: "The forum post to notify.",
      autocomplete: true,
      required: true,
    },
  ],
};

const port = Number.parseInt(process.env.PORT ?? "3000", 10);

if (Number.isNaN(port) === true || port <= 0) {
  throw new Error("PORT must be a valid positive number.");
}

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("OK");
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not Found");
});

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

    async reactionAdd(payload) {
      try {
        if (shouldProcessReactionPayload(payload as any) === false) {
          return;
        }

        await addRoleForReaction(
          bot,
          payload.channelId,
          payload.messageId,
          payload.userId,
        );
      } catch (error) {
        console.error("reactionAdd failed:", error);
      }
    },

    async reactionRemove(payload) {
      try {
        if (shouldProcessReactionPayload(payload as any) === false) {
          return;
        }

        await removeRoleForReaction(
          bot,
          payload.channelId,
          payload.messageId,
          payload.userId,
        );
      } catch (error) {
        console.error("reactionRemove failed:", error);
      }
    },

    async reactionRemoveEmoji(payload) {
      try {
        if (payload.guildId !== config.guildId) {
          return;
        }

        if ((payload.emoji as any).name !== config.reactionEmoji) {
          return;
        }

        await syncPostRoleForMessage(bot, payload.channelId, payload.messageId);
      } catch (error) {
        console.error("reactionRemoveEmoji failed:", error);
      }
    },

    async reactionRemoveAll(payload) {
      try {
        if (payload.guildId !== config.guildId) {
          return;
        }

        await syncPostRoleForMessage(bot, payload.channelId, payload.messageId);
      } catch (error) {
        console.error("reactionRemoveAll failed:", error);
      }
    },

    async interactionCreate(rawInteraction) {
      const interaction = rawInteraction as unknown as CommandInteraction;

      try {
        if (interaction.data?.name !== "notify") {
          return;
        }

        if (interaction.type === InteractionTypes.ApplicationCommandAutocomplete) {
          const posts = await getTrackedForumPosts(bot);
          const matches = getAutocompleteMatches(
            posts,
            getFocusedOptionValue(interaction),
          );

          await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
            type: InteractionResponseTypes.ApplicationCommandAutocompleteResult,
            data: {
              choices: matches,
            },
          } as any);
          return;
        }

        if (interaction.type !== InteractionTypes.ApplicationCommand) {
          return;
        }

        if (interaction.guildId !== config.guildId) {
          await safelyRespond(interaction, "This command only works in the target guild.");
          return;
        }

        const userId = interaction.user?.id;
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

        cleanupCooldown(userId);

        const remainingCooldown = getCooldownRemaining(userId);
        if (remainingCooldown > 0) {
          await safelyRespond(
            interaction,
            `You're on cooldown for another ${formatCooldown(remainingCooldown)}.`,
          );
          return;
        }

        const gameOption = getOptionValue(interaction, "game");
        if (typeof gameOption !== "string" || gameOption.trim().length === 0) {
          await safelyRespond(interaction, "Pick a game post first.");
          return;
        }

        const post = await getTrackedForumPostByName(bot, gameOption);
        if (post === null) {
          await safelyRespond(
            interaction,
            "I couldn't find that forum post. Use the autocomplete suggestions.",
          );
          return;
        }

        const role = await ensurePostRole(bot, post);

        await bot.helpers.sendMessage(post.id, {
          content: `<@&${role.id}> Heads up for ${post.name}.`,
        });

        setCooldown(userId);

        await safelyRespond(interaction, `Pinged ${post.name}.`);
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
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    await Promise.resolve(bot.shutdown?.());
    process.exit(0);
  } catch (error) {
    console.error("Shutdown failed:", error);
    process.exit(1);
  }
}

server.on("error", (error) => {
  console.error("HTTP server failed:", error);
  process.exit(1);
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Health server listening on 0.0.0.0:${port}`);
});

bot.start();
