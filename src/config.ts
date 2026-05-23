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
  notifyCooldownMs: 5 * 60 * 1000,
  reactionEmoji: "🎮",
  maxAutocompleteResults: 25,
  roleSuffix: " PING",
  maxRoleNameLength: 100,
  trackedPosts: [
    {
      id: 1507752111495053374n,
      name: "PEAK",
    },
    {
      id: 1507752025008508958n,
      name: "R.E.P.O",
    },
    {
      id: 1507751920763277393n,
      name: "Burglin' Gnomes",
    },
    {
      id: 1507751743931547738n,
      name: "Lethal Company",
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
