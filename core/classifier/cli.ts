#!/usr/bin/env node
// core/classifier/cli.ts — CLI runner for testing classification

import { loadConfig } from "../config.js";
import { Classifier } from "./index.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let message: string;

  if (args.length > 0) {
    message = args.join(" ");
  } else if (!process.stdin.isTTY) {
    message = await readStdin();
  } else {
    console.error("Usage:");
    console.error("  npx tsx core/classifier/cli.ts \"message to classify\"");
    console.error("  echo \"message\" | npx tsx core/classifier/cli.ts");
    process.exit(1);
  }

  if (!message) {
    console.error("Error: empty message");
    process.exit(1);
  }

  const config = loadConfig();
  const classifier = Classifier.fromConfig(config);
  const result = await classifier.classify(message);

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
