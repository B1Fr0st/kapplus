import {
  chromium,
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  type Frame,
  type Locator,
  type Page,
  type Response,
} from "playwright";
import type {
  KhanBrowserOptions,
  ConsoleEntry,
  ConsoleLevel,
  EditorState,
  PublishResult,
  ScreenshotResult,
  ScreenshotTarget,
} from "./browser-types.js";

export const KHAN_NEW_PROGRAM_URL =
  "https://www.khanacademy.org/computer-programming/new/pjs";
const KHAN_HOSTS = new Set(["khanacademy.org", "www.khanacademy.org"]);
const MAX_CONSOLE_ENTRIES = 500;

const EDITOR_SELECTORS = [
  ".scratchpad-ace-editor.ace_editor",
  ".scratchpad-ace-editor",
  ".ace_editor",
];

const CANVAS_SELECTORS = [
  "#output-canvas",
  "#output canvas",
  ".scratchpad-canvas-wrap canvas:not(.scratchpad-draw-canvas)",
  "canvas",
];

const RENDERED_CONSOLE_SELECTORS = [
  "#output-console",
  ".scratchpad-console",
  ".console-output",
  "[data-testid*='console']",
  "[class*='console-output']",
];

const ERROR_SELECTORS = [
  ".tipbar .message",
  ".error-message",
  "[role='alert']",
  ".ace_error",
];

function envBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function normalizeKhanUrl(
  url = process.env.KHAN_PROGRAM_URL || KHAN_NEW_PROGRAM_URL,
): string {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  const allowed = KHAN_HOSTS.has(host) || host.endsWith(".khanacademy.org");
  if (parsed.protocol !== "https:" || !allowed) {
    throw new Error("Only https://*.khanacademy.org URLs are allowed.");
  }
  return parsed.toString();
}

export function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function isKnownKhanConsoleNoise(text: string): boolean {
  const contentSecurityPolicy = text.includes(
    "violates the following Content Security Policy directive",
  );
  return (
    (contentSecurityPolicy && text.includes("font-src data")) ||
    (contentSecurityPolicy && text.includes("googletagmanager.com/gtm.js"))
  );
}

export function isNewKhanProgramUrl(url: string): boolean {
  const parsed = new URL(normalizeKhanUrl(url));
  return parsed.pathname.replace(/\/$/, "") === "/computer-programming/new/pjs";
}

export function isPublishedKhanProgramUrl(url: string): boolean {
  const parsed = new URL(normalizeKhanUrl(url));
  return /^\/computer-programming\/[^/]+\/\d+\/?$/.test(parsed.pathname);
}

export function describeKhanSaveResponse(
  status: number,
  statusText: string,
  body: string,
): string | null {
  const compactBody = body.replace(/\s+/g, " ").trim();
  if (status === 413 || /request entity too large|creation is too large/i.test(compactBody)) {
    return "Khan Academy rejected the program because the save payload is too large.";
  }
  if (status < 200 || status >= 300) {
    return `Khan Academy save request failed with HTTP ${status} ${statusText}` +
      (compactBody ? `: ${compactBody.slice(0, 500)}` : ".");
  }
  try {
    const parsed = JSON.parse(body) as {
      errors?: Array<{ message?: string }>;
      data?: { createProgram?: { error?: { code?: string; debugMessage?: string } } };
    };
    const messages = parsed.errors?.map((error) => error.message).filter(Boolean) ?? [];
    const programError = parsed.data?.createProgram?.error;
    if (programError) {
      messages.push(programError.debugMessage || programError.code || "createProgram failed");
    }
    if (messages.length > 0) return `Khan Academy createProgram failed: ${messages.join("; ")}`;
  } catch {
    // Successful GraphQL responses are JSON. If Khan changes the transport,
    // the browser's own modal remains the fallback error source below.
  }
  return null;
}

function consoleLevel(type: string): ConsoleLevel {
  if (type === "warn") return "warning";
  if (["log", "debug", "info", "warning", "error"].includes(type)) {
    return type as ConsoleLevel;
  }
  return "log";
}

export class KhanBrowserSession {
  constructor(private readonly options: KhanBrowserOptions = {}) {}
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private logs: ConsoleEntry[] = [];

  async getPage(): Promise<Page> {
    return this.requirePage();
  }

  async open(url?: string): Promise<EditorState> {
    const targetUrl = normalizeKhanUrl(url);
    const page = await this.ensurePage();

    if (page.url() !== targetUrl) {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    }

    await this.waitForEditor();
    await this.prepareVisibleWorkspace();
    return this.getState();
  }

  async setCode(code: string, settleMs = 800): Promise<EditorState> {
    const page = await this.requirePage();
    const editor = await this.findVisibleLocator(EDITOR_SELECTORS);
    if (!editor) {
      throw new Error(
        "Could not find Khan Academy's Ace editor. Open a ProcessingJS program first.",
      );
    }

    const didSet = await editor.locator.evaluate((element, nextCode) => {
      const candidate = element as HTMLElement & {
        env?: { editor?: { setValue(value: string, cursorPosition?: number): void; clearSelection?(): void } };
      };
      const aceEditor = candidate.env?.editor;
      if (aceEditor) {
        aceEditor.setValue(nextCode, -1);
        aceEditor.clearSelection?.();
        return true;
      }

      const aceGlobal = (globalThis as typeof globalThis & {
        ace?: { edit(element: Element): { setValue(value: string, cursorPosition?: number): void; clearSelection?(): void } };
      }).ace;
      if (aceGlobal) {
        const instance = aceGlobal.edit(element);
        instance.setValue(nextCode, -1);
        instance.clearSelection?.();
        return true;
      }
      return false;
    }, code);

    if (!didSet) {
      const input = editor.locator.locator("textarea.ace_text-input").first();
      await input.focus();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await page.keyboard.insertText(code);
    } else {
      // Khan's current editor no longer schedules a preview run for Ace's
      // programmatic setValue() change alone. A no-op keyboard edit preserves
      // the requested source while going through the same input path as a
      // learner typing in the editor.
      const input = editor.locator.locator("textarea.ace_text-input").first();
      await input.focus();
      await page.keyboard.insertText(" ");
      await page.keyboard.press("Backspace");
    }

    await page.waitForTimeout(Math.max(0, Math.min(settleMs, 10_000)));
    return this.getState();
  }

  async getState(options: { clearConsole?: boolean } = {}): Promise<EditorState> {
    const page = await this.requirePage();
    const [code, canvas, renderedConsole, errors] = await Promise.all([
      this.readCode(),
      this.readCanvasMetadata(),
      this.readVisibleText(RENDERED_CONSOLE_SELECTORS),
      this.readVisibleText(ERROR_SELECTORS),
    ]);

    const state: EditorState = {
      url: page.url(),
      title: await page.title(),
      code,
      canvas,
      console: [...this.logs],
      renderedConsole,
      errors,
    };

    if (options.clearConsole) this.logs = [];
    return state;
  }

  async start(settleMs = 250): Promise<EditorState> {
    const started = await this.setDrawLoop(true);
    if (!started) {
      throw new Error(
        "Could not find an initialized ProcessingJS runtime. Run code with a draw() " +
          "function before calling khan_start.",
      );
    }
    await this.waitAfterControl(settleMs);
    return this.getState();
  }

  async stop(settleMs = 100): Promise<EditorState> {
    const stopped = await this.setDrawLoop(false);
    if (!stopped) {
      throw new Error(
        "Could not find an initialized ProcessingJS runtime. Run code before calling khan_stop.",
      );
    }
    await this.waitAfterControl(settleMs);
    return this.getState();
  }

  async restart(settleMs = 800): Promise<EditorState> {
    const page = await this.requirePage();
    const restartButton = await this.findVisibleLocator(["#restart-code"]);

    if (restartButton) {
      // Invoke Khan's own click handler without depending on whether a
      // donation/cookie banner happens to overlap the control visually.
      await restartButton.locator.evaluate((element) => {
        (element as HTMLButtonElement).click();
      });
    } else {
      const didPost = await page.evaluate(() => {
        const frame = document.querySelector<HTMLIFrameElement>("#output-frame");
        if (!frame?.contentWindow) return false;
        const source = frame.dataset.src || frame.src;
        const origin = source ? new URL(source, window.location.href).origin : "*";
        frame.contentWindow.postMessage(JSON.stringify({ restart: true }), origin);
        return true;
      });
      if (!didPost) {
        throw new Error("Could not find Khan Academy's restart control or output frame.");
      }
    }

    await this.waitAfterControl(settleMs);
    return this.getState();
  }

  async screenshot(target: ScreenshotTarget): Promise<ScreenshotResult> {
    const page = await this.requirePage();
    if (target === "page") {
      return { data: await page.screenshot({ type: "png" }), target };
    }

    if (target === "output") {
      const output = await this.findVisibleLocator([
        "#output-frame",
        "#output",
        ".scratchpad-canvas-wrap",
      ]);
      if (!output) throw new Error("Could not find the Khan Academy output pane.");
      return { data: await output.locator.screenshot({ type: "png" }), target };
    }

    const canvas = await this.findVisibleLocator(CANVAS_SELECTORS);
    if (!canvas) throw new Error("Could not find a visible ProcessingJS canvas.");
    const snapshot = await canvas.locator.evaluate((element) => {
      const node = element as HTMLCanvasElement;
      return {
        width: node.width,
        height: node.height,
        dataUrl: node.toDataURL("image/png"),
      };
    });
    return {
      // Reading the bitmap directly prevents page overlays (for example
      // donation banners) from being composited into a canvas screenshot.
      data: Buffer.from(snapshot.dataUrl.slice(snapshot.dataUrl.indexOf(",") + 1), "base64"),
      width: snapshot.width,
      height: snapshot.height,
      target,
    };
  }

  async isAuthenticated(): Promise<boolean> {
    const page = await this.requirePage();
    const loginLink = page.locator("#login-or-signup");
    const count = await loginLink.count();
    for (let index = 0; index < count; index += 1) {
      if (await loginLink.nth(index).isVisible().catch(() => false)) return false;
    }
    return true;
  }

  async authenticate(timeoutMs = 10 * 60_000): Promise<EditorState> {
    const page = await this.requirePage();
    if (await this.isAuthenticated()) return this.getState();
    if (envBoolean(process.env.KHAN_HEADLESS, false)) {
      throw new Error(
        "Khan Academy login requires a visible browser. Unset KHAN_HEADLESS and try again.",
      );
    }

    const loginLink = page.locator("#login-or-signup").first();
    if (!(await loginLink.isVisible().catch(() => false))) {
      throw new Error("Could not find Khan Academy's Log in link.");
    }
    await loginLink.click();

    const deadline = Date.now() + Math.max(1_000, timeoutMs);
    while (Date.now() < deadline) {
      const editor = await this.findVisibleLocator(EDITOR_SELECTORS);
      if (editor && (await this.isAuthenticated())) {
        await this.prepareVisibleWorkspace();
        return this.getState();
      }
      await page.waitForTimeout(500);
    }
    throw new Error(
      `Khan Academy login was not completed within ${Math.ceil(timeoutMs / 1_000)} seconds.`,
    );
  }

  async waitForKapPlusLoader(timeoutMs = 60_000): Promise<string> {
    const page = await this.requirePage();
    const deadline = Date.now() + Math.max(1_000, timeoutMs);
    while (Date.now() < deadline) {
      for (const frame of page.frames()) {
        const status = await frame.evaluate(() => {
          return (globalThis as typeof globalThis & {
            __kapplusLoaderStatus?: unknown;
          }).__kapplusLoaderStatus;
        }).catch(() => undefined);
        if (status === "ready") return status;
        if (typeof status === "string" && status !== "loading") {
          throw new Error(`KAP+ loader failed in Khan Academy: ${status}`);
        }
      }
      await page.waitForTimeout(200);
    }
    throw new Error(
      `KAP+ loader did not reach ready within ${Math.ceil(timeoutMs / 1_000)} seconds.`,
    );
  }

  async publishNewProgram(title: string, timeoutMs = 120_000): Promise<PublishResult> {
    const page = await this.requirePage();
    const normalizedTitle = title.trim();
    if (!normalizedTitle) throw new Error("A non-empty Khan Academy program title is required.");
    if (!isNewKhanProgramUrl(page.url())) {
      throw new Error(
        "KAP+ only publishes from Khan Academy's blank new-program editor; " +
          "refusing to overwrite an existing program.",
      );
    }
    if (!(await this.isAuthenticated())) {
      throw new Error(
        "Khan Academy is not authenticated. Run `kapplus auth` with the same " +
          "KHAN_USER_DATA_DIR, then retry publishing.",
      );
    }

    const code = await this.readCode();
    if (code === null) throw new Error("Could not read the Khan Academy editor contents.");
    const codeBytes = Buffer.byteLength(code);
    const saveButton = await this.waitForVisibleButton("Save", Math.min(timeoutMs, 15_000));
    await saveButton.click();

    const dialog = page.getByRole("dialog").filter({ hasText: "Save As..." }).first();
    await dialog.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 15_000) });
    const titleInput = dialog.locator('input[type="text"]').first();
    await titleInput.fill(normalizedTitle);
    const confirmButton = dialog.getByRole("button", { name: "Save", exact: true }).first();
    let saveFailure: string | undefined;
    const inspectSaveResponse = async (response: Response): Promise<void> => {
      const request = response.request();
      if (request.method() !== "POST" || !/\/api\/internal\/graphql\//.test(response.url())) return;
      const requestBody = request.postData() ?? "";
      if (!/createProgram/i.test(response.url()) && !/createProgram/i.test(requestBody)) return;
      const body = await response.text().catch(() => "");
      const detail = describeKhanSaveResponse(response.status(), response.statusText(), body);
      if (detail) saveFailure = `${detail} Generated code is ${codeBytes.toLocaleString()} bytes.`;
    };
    const responseListener = (response: Response): void => {
      void inspectSaveResponse(response);
    };
    page.on("response", responseListener);
    await confirmButton.click();

    try {
      const deadline = Date.now() + Math.max(1_000, timeoutMs);
      while (Date.now() < deadline) {
        if (saveFailure) throw new Error(saveFailure);
        if (isPublishedKhanProgramUrl(page.url())) {
          return {
            title: normalizedTitle,
            url: page.url(),
            codeBytes,
          };
        }

        const visibleDialogText = await this.readVisibleText(["[role='dialog']"]);
        const saveError = visibleDialogText.find((text) => /^Error\b/i.test(text));
        if (saveError) {
          throw new Error(
            `Khan Academy could not save the ${codeBytes.toLocaleString()}-byte program: ${saveError}`,
          );
        }
        await page.waitForTimeout(250);
      }
      throw new Error(
        `Khan Academy did not return a published program URL within ` +
          `${Math.ceil(timeoutMs / 1_000)} seconds. Generated code is ` +
          `${codeBytes.toLocaleString()} bytes.`,
      );
    } finally {
      page.off("response", responseListener);
    }
  }

  clearConsole(): void {
    this.logs = [];
  }

  async close(): Promise<void> {
    const context = this.context;
    const browser = this.browser;
    this.page = undefined;
    this.context = undefined;
    this.browser = undefined;
    let failure: unknown;
    for (const resource of [context, browser]) {
      try { await resource?.close(); }
      catch (error) {
        // Chromium can receive the same SIGINT as the CLI and dispose itself
        // before our shutdown handler runs. Still attempt every cleanup step.
        if (!/Target closed|has been closed|Failed to find context|Target\.disposeBrowserContext/i.test(String(error))) failure = error;
      }
    }
    if (failure) throw failure;
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;

    const cdpUrl = this.options.cdpUrl ?? process.env.KHAN_CDP_URL;
    if (cdpUrl) {
      this.browser = await chromium.connectOverCDP(cdpUrl);
      this.context = this.browser.contexts()[0] ?? (await this.browser.newContext());
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
    } else {
      const headless = this.options.headless ?? envBoolean(process.env.KHAN_HEADLESS, false);
      const executablePath = this.options.executablePath ?? process.env.KHAN_BROWSER_EXECUTABLE;
      const channel = this.options.channel ?? (process.env.KHAN_BROWSER_CHANNEL || undefined);
      const userDataDir = this.options.userDataDir ?? process.env.KHAN_USER_DATA_DIR;
      const launchOptions = { headless, executablePath, channel };

      if (userDataDir) {
        this.context = await chromium.launchPersistentContext(userDataDir, launchOptions);
        this.page = this.context.pages()[0] ?? (await this.context.newPage());
      } else {
        this.browser = await chromium.launch(launchOptions);
        this.context = await this.browser.newContext({ viewport: { width: 1440, height: 1000 } });
        this.page = await this.context.newPage();
      }
    }

    this.captureConsole(this.page);
    return this.page;
  }

  private async requirePage(): Promise<Page> {
    if (!this.page || this.page.isClosed()) {
      throw new Error("No Khan Academy page is open. Call khan_open first.");
    }
    return this.page;
  }

  private captureConsole(page: Page): void {
    page.on("console", (message) => this.addConsoleMessage(message));
    page.on("pageerror", (error) => {
      this.pushLog({
        level: "error",
        text: error.stack || error.message,
        timestamp: new Date().toISOString(),
      });
    });
  }

  private addConsoleMessage(message: ConsoleMessage): void {
    const location = message.location();
    this.pushLog({
      level: consoleLevel(message.type()),
      text: message.text(),
      timestamp: new Date().toISOString(),
      source: location.url || undefined,
      line: location.lineNumber || undefined,
      column: location.columnNumber || undefined,
    });
  }

  private pushLog(entry: ConsoleEntry): void {
    this.logs.push(entry);
    if (this.logs.length > MAX_CONSOLE_ENTRIES) {
      this.logs.splice(0, this.logs.length - MAX_CONSOLE_ENTRIES);
    }
  }

  private async waitForEditor(): Promise<void> {
    const page = await this.requirePage();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await this.findVisibleLocator(EDITOR_SELECTORS)) return;
      await page.waitForTimeout(250);
    }
    throw new Error(
      "Khan Academy loaded, but no code editor appeared within 30 seconds. " +
        "Check for a login, consent, or anti-bot interstitial in the browser window.",
    );
  }

  private async waitAfterControl(settleMs: number): Promise<void> {
    const page = await this.requirePage();
    await page.waitForTimeout(Math.max(0, Math.min(settleMs, 10_000)));
  }

  private async prepareVisibleWorkspace(): Promise<void> {
    const page = await this.requirePage();
    await page.evaluate(() => {
      const selectors = [
        "#donate-banner",
        "[data-testid='donate-banner']",
        "#onetrust-banner-sdk",
        ".onetrust-pc-dark-filter",
      ];
      for (const selector of selectors) {
        for (const element of document.querySelectorAll<HTMLElement>(selector)) {
          element.style.setProperty("display", "none", "important");
        }
      }
      document.querySelector("#output-frame")?.scrollIntoView({ block: "center" });
    });
  }

  private async setDrawLoop(running: boolean): Promise<boolean> {
    for (const frame of this.frames()) {
      const controlled = await frame
        .evaluate((shouldRun) => {
          type ProcessingInstance = { loop?(): void; noLoop?(): void; externals?: { canvas?: Element } };
          type ProcessingGlobal = {
            getInstanceById?(id: string): ProcessingInstance | undefined;
            instances?: ProcessingInstance[];
          };

          const processing = (globalThis as typeof globalThis & {
            Processing?: ProcessingGlobal;
          }).Processing;
          if (!processing) return false;

          const instance =
            processing.getInstanceById?.("output-canvas") ??
            processing.instances?.find(
              (candidate) => candidate.externals?.canvas?.id === "output-canvas",
            ) ??
            processing.instances?.[0];

          const control = shouldRun ? instance?.loop : instance?.noLoop;
          if (!instance || typeof control !== "function") return false;
          control.call(instance);
          return true;
        }, running)
        .catch(() => false);
      if (controlled) return true;
    }
    return false;
  }

  private frames(): Frame[] {
    const page = this.page;
    return page ? page.frames() : [];
  }

  private async findVisibleLocator(
    selectors: string[],
  ): Promise<{ frame: Frame; locator: Locator } | null> {
    for (const frame of this.frames()) {
      for (const selector of selectors) {
        const candidates = frame.locator(selector);
        const count = Math.min(await candidates.count().catch(() => 0), 10);
        for (let index = 0; index < count; index += 1) {
          const locator = candidates.nth(index);
          if (await locator.isVisible().catch(() => false)) return { frame, locator };
        }
      }
    }
    return null;
  }

  private async waitForVisibleButton(label: string, timeoutMs: number): Promise<Locator> {
    const page = await this.requirePage();
    const deadline = Date.now() + Math.max(1_000, timeoutMs);
    while (Date.now() < deadline) {
      const candidates = page.getByRole("button", { name: label, exact: true });
      const count = await candidates.count();
      for (let index = 0; index < count; index += 1) {
        const candidate = candidates.nth(index);
        if (await candidate.isVisible().catch(() => false)) return candidate;
      }
      await page.waitForTimeout(100);
    }
    throw new Error(`Could not find Khan Academy's ${label} button.`);
  }

  private async readCode(): Promise<string | null> {
    const editor = await this.findVisibleLocator(EDITOR_SELECTORS);
    if (!editor) return null;
    return editor.locator.evaluate((element) => {
      const candidate = element as HTMLElement & {
        env?: { editor?: { getValue(): string } };
      };
      if (candidate.env?.editor) return candidate.env.editor.getValue();
      const aceGlobal = (globalThis as typeof globalThis & {
        ace?: { edit(element: Element): { getValue(): string } };
      }).ace;
      if (aceGlobal) return aceGlobal.edit(element).getValue();
      return element.textContent;
    });
  }

  private async readCanvasMetadata(): Promise<EditorState["canvas"]> {
    const canvas = await this.findVisibleLocator(CANVAS_SELECTORS);
    if (!canvas) return { found: false };
    const size = await canvas.locator.evaluate((element) => {
      const node = element as HTMLCanvasElement;
      return { width: node.width, height: node.height };
    });
    return { found: true, ...size };
  }

  private async readVisibleText(selectors: string[]): Promise<string[]> {
    const values: string[] = [];
    for (const frame of this.frames()) {
      for (const selector of selectors) {
        const candidates = frame.locator(selector);
        const count = Math.min(await candidates.count().catch(() => 0), 20);
        for (let index = 0; index < count; index += 1) {
          const locator = candidates.nth(index);
          if (!(await locator.isVisible().catch(() => false))) continue;
          const value = await locator.innerText().catch(() => "");
          values.push(value);
        }
      }
    }
    return uniqueNonEmpty(values);
  }
}
