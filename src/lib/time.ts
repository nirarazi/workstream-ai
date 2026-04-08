/**
 * Relative time formatting utility.
 * No external dependencies — pure Date math.
 * Handles both ISO 8601 strings and Slack epoch timestamps.
 */

export function timeAgo(timestamp: string): string {
  const now = Date.now();
  let then = new Date(timestamp).getTime();

  // Fallback: try parsing as Slack epoch (e.g. "1774958531.590819")
  if (Number.isNaN(then)) {
    const epoch = parseFloat(timestamp);
    if (!Number.isNaN(epoch)) {
      then = epoch * 1000;
    } else {
      return "";
    }
  }

  const diffMs = now - then;
  if (diffMs < 0) return "just now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  const years = Math.floor(months / 12);
  return `${years}y ago`;
}
