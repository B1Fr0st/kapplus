export type ConsoleLevel = "log" | "debug" | "info" | "warning" | "error";

export interface KhanBrowserOptions {
  headless?: boolean;
  executablePath?: string;
  channel?: string;
  userDataDir?: string;
  cdpUrl?: string;
}

export interface ConsoleEntry {
  level: ConsoleLevel;
  text: string;
  timestamp: string;
  source?: string;
  line?: number;
  column?: number;
}

export interface EditorState {
  url: string;
  title: string;
  code: string | null;
  canvas: {
    found: boolean;
    width?: number;
    height?: number;
  };
  console: ConsoleEntry[];
  renderedConsole: string[];
  errors: string[];
}

export type ScreenshotTarget = "canvas" | "output" | "page";

export interface ScreenshotResult {
  data: Buffer;
  width?: number;
  height?: number;
  target: ScreenshotTarget;
}

export interface PublishResult {
  title: string;
  url: string;
  codeBytes: number;
}
