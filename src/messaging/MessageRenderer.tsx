import type { JSX } from "react";
import { PlatformMessage } from "./registry";

interface MessageRendererProps {
  platform: string;
  text: string;
  userMap?: Map<string, string>;
}

export default function MessageRenderer({ platform, text, userMap }: MessageRendererProps): JSX.Element {
  return <PlatformMessage platform={platform} text={text} userMap={userMap} />;
}
