import type { Bot } from "discordeno";
import { config } from "./config.js";

export interface ForumPostRecord {
  id: bigint;
  name: string;
  starterMessageId: bigint;
}

type DiscordBot = Bot<any>;
type GuildMemberLike = {
  id: bigint;
  roles: bigint[];
};
type RoleLike = {
  id: bigint;
  name: string;
};

function toBigInt(value: bigint | string): bigint {
  if (typeof value === "bigint") {
    return value;
  }

  return BigInt(value);
}

function getRoleName(postName: string): string {
  const normalizedName = postName.trim().toUpperCase();
  const availableLength =
    config.maxRoleNameLength - config.roleSuffix.length;
  const safeName = normalizedName.slice(0, Math.max(1, availableLength)).trim();
  return `${safeName}${config.roleSuffix}`;
}

export async function getTrackedForumPosts(
  _bot: DiscordBot,
): Promise<ForumPostRecord[]> {
  return config.trackedPosts
    .map((post) => ({
      id: post.id,
      name: post.name,
      starterMessageId: post.starterMessageId,
    }))
    .sort((left, right) =>
    left.name.localeCompare(right.name),
    );
}

export async function getTrackedForumPostById(
  bot: DiscordBot,
  postId: bigint,
): Promise<ForumPostRecord | null> {
  const posts = await getTrackedForumPosts(bot);

  for (const post of posts) {
    if (post.id === postId) {
      return post;
    }
  }

  return null;
}

export async function getTrackedForumPostByName(
  bot: DiscordBot,
  name: string,
): Promise<ForumPostRecord | null> {
  const normalizedName = name.trim().toLowerCase();
  const posts = await getTrackedForumPosts(bot);

  for (const post of posts) {
    if (post.name.trim().toLowerCase() === normalizedName) {
      return post;
    }
  }

  return null;
}

async function getRoleByName(
  bot: DiscordBot,
  roleName: string,
): Promise<RoleLike | null> {
  const roles = (await bot.helpers.getRoles(config.guildId)) as RoleLike[];

  for (const role of roles) {
    if (role.name === roleName) {
      return role;
    }
  }

  return null;
}

export async function ensurePostRole(
  bot: DiscordBot,
  post: ForumPostRecord,
): Promise<RoleLike> {
  const roleName = getRoleName(post.name);
  const existingRole = await getRoleByName(bot, roleName);

  if (existingRole !== null) {
    return existingRole;
  }

  return (await bot.helpers.createRole(config.guildId, {
    name: roleName,
    mentionable: true,
  })) as RoleLike;
}

async function getAllGuildMembers(bot: DiscordBot): Promise<GuildMemberLike[]> {
  const members: GuildMemberLike[] = [];
  let after = 0n;

  while (true) {
    const batch = (await bot.helpers.getMembers(config.guildId, {
      limit: 1000,
      after: after.toString(),
    })) as GuildMemberLike[];

    if (batch.length === 0) {
      break;
    }

    members.push(...batch);
    after = batch[batch.length - 1]!.id;

    if (batch.length < 1000) {
      break;
    }
  }

  return members;
}

function isVideoGameReaction(emoji: { name?: string | null }): boolean {
  return emoji.name === config.reactionEmoji;
}

export function shouldProcessReactionPayload(payload: {
  guildId?: bigint;
  channelId: bigint;
  messageId: bigint;
  emoji: { name?: string | null } | Record<string, unknown>;
}): boolean {
  const emojiName =
    "name" in payload.emoji ? (payload.emoji.name as string | null | undefined) : undefined;

  return (
    payload.guildId === config.guildId &&
    payload.channelId !== config.forumChannelId &&
    isVideoGameReaction({ name: emojiName })
  );
}

async function getReactedUserIds(
  bot: DiscordBot,
  post: ForumPostRecord,
): Promise<Set<bigint>> {
  const reactedUserIds = new Set<bigint>();
  let after: string | undefined;

  while (true) {
    const users = (await bot.helpers.getReactions(
      post.id,
      post.starterMessageId,
      config.reactionEmoji,
      {
        after,
        limit: 100,
        type: 0,
      },
    )) as Array<{ id: bigint; bot?: boolean }>;

    if (users.length === 0) {
      break;
    }

    for (const user of users) {
      if (user.bot === true) {
        continue;
      }

      reactedUserIds.add(user.id);
    }

    if (users.length < 100) {
      break;
    }

    after = users[users.length - 1]!.id.toString();
  }

  return reactedUserIds;
}

export async function syncPostRoleMembers(
  bot: DiscordBot,
  post: ForumPostRecord,
): Promise<RoleLike> {
  const role = await ensurePostRole(bot, post);
  const reactedUserIds = await getReactedUserIds(bot, post);
  const members = await getAllGuildMembers(bot);

  for (const member of members) {
    const hasRole = member.roles.includes(role.id);
    const shouldHaveRole = reactedUserIds.has(member.id);

    if (shouldHaveRole === true && hasRole === false) {
      await bot.helpers.addRole(config.guildId, member.id, role.id);
      continue;
    }

    if (shouldHaveRole === false && hasRole === true) {
      await bot.helpers.removeRole(config.guildId, member.id, role.id);
    }
  }

  return role;
}

export async function syncAllPostRoles(bot: DiscordBot): Promise<void> {
  const posts = await getTrackedForumPosts(bot);

  for (const post of posts) {
    await ensurePostRole(bot, post);

    try {
      await syncPostRoleMembers(bot, post);
    } catch (error) {
      console.warn(`Skipping startup reaction sync for ${post.name}:`, error);
    }
  }
}

export async function syncPostRoleForMessage(
  bot: DiscordBot,
  channelId: bigint,
  messageId: bigint,
): Promise<void> {
  const post = await getTrackedForumPostById(bot, channelId);

  if (post === null) {
    return;
  }

  if (post.starterMessageId !== messageId) {
    return;
  }

  await syncPostRoleMembers(bot, post);
}

export async function addRoleForReaction(
  bot: DiscordBot,
  channelId: bigint,
  messageId: bigint,
  userId: bigint,
): Promise<void> {
  const post = await getTrackedForumPostById(bot, channelId);

  if (post === null || post.starterMessageId !== messageId) {
    return;
  }

  const role = await ensurePostRole(bot, post);
  const member = (await bot.helpers.getMember(
    config.guildId,
    userId,
  )) as GuildMemberLike;

  if (member.roles.includes(role.id) === false) {
    await bot.helpers.addRole(config.guildId, userId, role.id);
  }
}

export async function removeRoleForReaction(
  bot: DiscordBot,
  channelId: bigint,
  messageId: bigint,
  userId: bigint,
): Promise<void> {
  const post = await getTrackedForumPostById(bot, channelId);

  if (post === null || post.starterMessageId !== messageId) {
    return;
  }

  const role = await ensurePostRole(bot, post);
  const member = (await bot.helpers.getMember(
    config.guildId,
    userId,
  )) as GuildMemberLike;

  if (member.roles.includes(role.id) === true) {
    await bot.helpers.removeRole(config.guildId, userId, role.id);
  }
}

export function getAutocompleteMatches(
  posts: ForumPostRecord[],
  query: string,
): { name: string; value: string }[] {
  const normalizedQuery = query.trim().toLowerCase();
  const startsWithMatches: ForumPostRecord[] = [];
  const includesMatches: ForumPostRecord[] = [];

  for (const post of posts) {
    const normalizedName = post.name.toLowerCase();

    if (normalizedQuery.length === 0 || normalizedName.startsWith(normalizedQuery)) {
      startsWithMatches.push(post);
      continue;
    }

    if (normalizedName.includes(normalizedQuery)) {
      includesMatches.push(post);
    }
  }

  return [...startsWithMatches, ...includesMatches]
    .slice(0, config.maxAutocompleteResults)
    .map((post) => ({
      name: post.name,
      value: post.name,
    }));
}
