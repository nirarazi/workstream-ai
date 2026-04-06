/**
 * Slack-specific mention serialization.
 * Converts a platform user ID into the Slack wire format for mentions.
 */
export function slackSerializeMention(userId: string): string {
  return `<@${userId}>`;
}
