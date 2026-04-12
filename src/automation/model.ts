export const PROTECT_TOOLS = ['claude', 'codex', 'openclaw'] as const;
export const UPDATE_CHANNELS = ['latest', 'next'] as const;

export type ProtectTool = (typeof PROTECT_TOOLS)[number];
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export function isProtectTool(value: string): value is ProtectTool {
  return PROTECT_TOOLS.includes(value as ProtectTool);
}

export function isUpdateChannel(value: string): value is UpdateChannel {
  return UPDATE_CHANNELS.includes(value as UpdateChannel);
}
