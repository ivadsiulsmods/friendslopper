const token = process.env.DISCORD_TOKEN;

if (token === undefined || token.length === 0) {
  throw new Error("DISCORD_TOKEN is required.");
}

export const config = {
  token,
  guildId: 1331406970732937336n,
  forumChannelId: 1507096852976373760n,
  ignoredPostId: 1507519991736438895n,
  notifierRoleId: 1501620031421939814n,
  adminRoleId: 1331447283904024596n,
  notifyCooldownMs: 5 * 60 * 1000,
  reactionEmoji: "\u{1F3AE}",
  maxAutocompleteResults: 25,
  roleSuffix: " PING",
  maxRoleNameLength: 100,
  trackedPosts: [
    {
      id: 1507752111495053374n,
      name: "PEAK",
      starterMessageId: 1507752111495053374n,
    },
    {
      id: 1507752025008508958n,
      name: "R.E.P.O",
      starterMessageId: 1507752025008508958n,
    },
    {
      id: 1507751920763277393n,
      name: "Burglin' Gnomes",
      starterMessageId: 1507751920763277393n,
    },
    {
      id: 1507751743931547738n,
      name: "Lethal Company",
      starterMessageId: 1507751743931547738n,
    },
  ],
} as const;

export function formatCooldown(msRemaining: number): string {
  const totalSeconds = Math.max(1, Math.ceil(msRemaining / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  if (seconds === 0) {
    return `${minutes}m`;
  }

  return `${minutes}m ${seconds}s`;
}
