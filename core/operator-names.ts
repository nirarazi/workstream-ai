// core/operator-names.ts — The ways the operator is named, for telling their asks and handoffs from others'

import type { OperatorIdentityMap } from "./types.js";

/** The ways a model names the operator in "who it's waiting on": platform IDs, usernames, full and first names */
export function operatorNames(identities: OperatorIdentityMap | undefined, configuredName: string | undefined): string[] {
  const names = [
    ...[...(identities?.values() ?? [])].flatMap((id) => [id.userId, id.userName]),
    configuredName,
  ].filter((n): n is string => Boolean(n?.trim()));
  return [...new Set([...names, ...names.map((n) => n.trim().split(/[\s.]+/)[0])])];
}
