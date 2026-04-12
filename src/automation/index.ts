export {
  DEFAULT_AUTOMATION_STATE_PATH_DISPLAY,
  clearProtectRuntimeState,
  cloneAutomationState,
  createDefaultAutomationState,
  createDefaultProtectToolRuntimeState,
  loadAutomationState,
  resolveAutomationStatePath,
  saveAutomationState,
} from './state.js';
export type {
  AutomationState,
  LoadedAutomationState,
  ProtectToolRuntimeState,
  UpdateCheckResult,
} from './state.js';
export { PROTECT_TOOLS, UPDATE_CHANNELS, isProtectTool, isUpdateChannel } from './model.js';
export type { ProtectTool, UpdateChannel } from './model.js';
