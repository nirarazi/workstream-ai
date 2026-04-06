/**
 * Slack-specific URL builders.
 */

/** Build a URL that opens a specific thread in Slack */
export function buildSlackThreadUrl(
  workspaceUrl: string,
  channelId: string,
  threadTs?: string,
): string {
  const base = `${workspaceUrl}/archives/${channelId}`;
  if (threadTs) {
    return `${base}/p${threadTs.replace(".", "")}`;
  }
  return base;
}
