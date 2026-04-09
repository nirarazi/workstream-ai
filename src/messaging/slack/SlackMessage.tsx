import type { JSX } from "react";
import { parseSlackMessage, type Segment } from "./format";
import { openExternalUrl } from "../../lib/api";

interface SlackMessageProps {
  text: string;
  /** Map of Slack user ID → display name for resolving bare mentions */
  userMap?: Map<string, string>;
}

function renderSegment(seg: Segment, i: number): JSX.Element {
  switch (seg.type) {
    case "text":
      return <span key={i}>{seg.value}</span>;

    case "mention":
      return (
        <span
          key={i}
          className="rounded bg-cyan-900/50 px-1 py-0.5 text-cyan-300 font-medium"
        >
          @{seg.name}
        </span>
      );

    case "channel":
      return (
        <span
          key={i}
          className="rounded bg-cyan-900/50 px-1 py-0.5 text-cyan-300 font-medium"
        >
          #{seg.name}
        </span>
      );

    case "broadcast":
      return (
        <span
          key={i}
          className="rounded bg-amber-900/50 px-1 py-0.5 text-amber-300 font-medium"
        >
          @{seg.name}
        </span>
      );

    case "link":
      return (
        <button
          key={i}
          type="button"
          onClick={() => openExternalUrl(seg.url)}
          className="text-cyan-400 hover:underline cursor-pointer"
        >
          {seg.label}
        </button>
      );

    case "emoji":
      if (seg.unicode) {
        return <span key={i}>{seg.unicode}</span>;
      }
      // Render unrecognized shortcode as-is in muted text
      return (
        <span key={i} className="text-gray-500">
          {seg.shortcode}
        </span>
      );

    case "code":
      return (
        <code
          key={i}
          className="rounded bg-gray-800 px-1.5 py-0.5 text-xs font-mono text-gray-300"
        >
          {seg.value}
        </code>
      );

    case "bold":
      return (
        <strong key={i} className="font-semibold">
          {seg.value}
        </strong>
      );

    case "italic":
      return (
        <em key={i} className="italic">
          {seg.value}
        </em>
      );
  }
}

export default function SlackMessage({ text, userMap }: SlackMessageProps): JSX.Element {
  const segments = parseSlackMessage(text, { userMap });
  return <>{segments.map(renderSegment)}</>;
}
