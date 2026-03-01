import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { getHeadersWithAuth } from "../browser/cdp.helpers.js";
import { getChromeWebSocketUrl, launchOpenClawChrome } from "../browser/chrome.js";
import { resolveBrowserConfig, resolveProfile } from "../browser/config.js";
import { loadConfig } from "../config/io.js";

export interface ManusWebClientOptions {
  cookie?: string;
  userAgent?: string;
  headless?: boolean;
}

export class ManusWebClientBrowser {
  private options: ManusWebClientOptions;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private initialized = false;

  constructor(options: ManusWebClientOptions) {
    this.options = options;
  }

  private parseCookies(): Array<{ name: string; value: string; domain: string; path: string }> {
    const cookieStr = this.options.cookie ?? "";
    return cookieStr
      .split(";")
      .filter((c) => c.trim().includes("="))
      .map((cookie) => {
        const [name, ...valueParts] = cookie.trim().split("=");
        return {
          name: name?.trim() ?? "",
          value: valueParts.join("=").trim(),
          domain: ".manus.im",
          path: "/",
        };
      })
      .filter((c) => c.name.length > 0);
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const rootConfig = loadConfig();
    const browserConfig = resolveBrowserConfig(rootConfig.browser, rootConfig);
    const profile = resolveProfile(browserConfig, browserConfig.defaultProfile);
    if (!profile) {
      throw new Error(`Could not resolve browser profile '${browserConfig.defaultProfile}'`);
    }

    let wsUrl: string | null = null;

    if (browserConfig.attachOnly) {
      console.log(`[Manus Web Browser] Connecting to existing Chrome at ${profile.cdpUrl}`);
      for (let i = 0; i < 10; i++) {
        wsUrl = await getChromeWebSocketUrl(profile.cdpUrl, 2000);
        if (wsUrl) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!wsUrl) {
        throw new Error(
          `Failed to connect to Chrome at ${profile.cdpUrl}. ` +
            `Make sure Chrome is running in debug mode (./start-chrome-debug.sh)`,
        );
      }
    } else {
      const running = await launchOpenClawChrome(browserConfig, profile);
      const cdpUrl = `http://127.0.0.1:${running.cdpPort}`;
      for (let i = 0; i < 10; i++) {
        wsUrl = await getChromeWebSocketUrl(cdpUrl, 2000);
        if (wsUrl) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!wsUrl) {
        throw new Error(`Failed to resolve Chrome WebSocket URL from ${cdpUrl}`);
      }
    }

    const connectedBrowser = await chromium.connectOverCDP(wsUrl, {
      headers: getHeadersWithAuth(wsUrl),
    });
    this.browser = connectedBrowser;
    this.context = connectedBrowser.contexts()[0];

    const pages = this.context.pages();
    const manusPage = pages.find((p) => p.url().includes("manus.im"));
    if (manusPage) {
      console.log(`[Manus Web Browser] Found existing Manus page`);
      this.page = manusPage;
    } else {
      this.page = await this.context.newPage();
      await this.page.goto("https://manus.im/app", { waitUntil: "domcontentloaded" });
    }

    const cookies = this.parseCookies();
    if (cookies.length > 0) {
      try {
        await this.context.addCookies(cookies);
      } catch (e) {
        console.warn("[Manus Web Browser] Failed to add some cookies:", e);
      }
    }

    this.initialized = true;
  }

  /**
   * DOM 模拟：通过真实浏览器交互发送消息，绕过 api.manus.im Connect RPC 协议复杂度
   * 抓包显示：认证为 Bearer JWT，发消息接口未捕获（可能 WebSocket），采用 DOM 模拟更可靠
   */
  private async chatCompletionsViaDOM(params: {
    message: string;
    signal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array>> {
    if (!this.page) throw new Error("ManusWebClientBrowser not initialized");

    // Playwright 原生 API：fill/pressSequentially 对 ProseMirror contenteditable 兼容更好
    const inputSelectors = [
      ".ProseMirror",
      '[contenteditable="true"]',
      '[placeholder*="任务"]',
      '[placeholder*="提问"]',
      '[placeholder*="分配"]',
      "textarea",
      'div[role="textbox"]',
    ];
    const inputLoc = this.page.locator(inputSelectors.join(", ")).first();
    await inputLoc.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    if ((await inputLoc.count()) === 0) {
      throw new Error("Manus DOM 模拟失败: 找不到输入框");
    }

    await inputLoc.click();
    await inputLoc.fill("");
    await inputLoc.pressSequentially(params.message, { delay: 15 });

    // 发送：Manus 图标栏 [+] [mic] [img] [↑]，优先点「发送」按钮，否则取输入区父容器内最后一按钮
    await this.page.evaluate(() => {
      const input = document.querySelector(".ProseMirror, [contenteditable=true], textarea, [placeholder*='任务']");
      if (!input) return;
      let scope: Element | null = input.parentElement;
      let depth = 0;
      while (scope && depth < 8) {
        const btns = scope.querySelectorAll("button, [role='button']");
        if (btns.length > 0 && btns.length <= 8) break;
        scope = scope.parentElement;
        depth++;
      }
      scope = scope ?? input.parentElement ?? document.body;
      const notInput = (el: Element) => !input.contains(el) && !el.contains(input);
      const candidates = Array.from(scope.querySelectorAll("button, [role='button']")).filter(notInput);
      const clickables = candidates.filter((el) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !(el as HTMLButtonElement).disabled;
      });
      const sendLike = (el: Element) => {
        const a = (el.getAttribute("aria-label") ?? "").toLowerCase();
        const t = (el.getAttribute("title") ?? "").toLowerCase();
        const txt = ((el as HTMLElement).textContent ?? "").toLowerCase();
        return /send|发送|submit|提交|arrow|up|↑/.test(a + t + txt);
      };
      const sendBtn =
        clickables.find(sendLike) ?? (clickables.length > 0 ? clickables[clickables.length - 1] : null);
      if (sendBtn) {
        (sendBtn as HTMLElement).click();
      } else {
        (input as HTMLElement).dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
        );
      }
    });

    console.log("[Manus Web Browser] DOM 模拟已发送，轮询等待回复...");

    const maxWaitMs = 120000;
    const pollIntervalMs = 2000;
    let lastText = "";

    // 等待 Manus 开始渲染回复（避免首轮轮询时 DOM 尚未更新）
    await new Promise((r) => setTimeout(r, 1500));
    let stableCount = 0;
    const signal = params.signal;

    for (let elapsed = 0; elapsed < maxWaitMs; elapsed += pollIntervalMs) {
      if (signal?.aborted) throw new Error("Manus 请求已取消");

      await new Promise((r) => setTimeout(r, pollIntervalMs));

      const result = await this.page.evaluate(() => {
        const clean = (t: string) => t.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();

        const skipTexts = [
          "输入消息",
          "输入提示",
          "Send a message",
          "Manus",
          "发起新对话",
          "正在加载",
          "Loading",
          "分配一个任务或提问任何问题",
          "我能为你做什么",
          "将您的工具连接到 Manus",
          "个性化您的Manus",
          "新建任务",
          "免费计划",
          "开始免费试用",
          "项目新项目所有任务",
          "思考过程", // Manus thinking process header
          "任务完成时收到通知",
          "下载 Manus 应用",
          "Manus 解答您的问题效果如何",
          "创建",
          "开启 Agent",
        ];
        const isGreeting = (t: string) =>
          t.length < 15 && (/^你好$/i.test(t) || /^hi$/i.test(t) || /^您好$/i.test(t));
        const isSkip = (t: string) =>
          skipTexts.some((s) => t.includes(s)) || isGreeting(t) || t.length < 10;

        // Manus 布局：输入框为 ProseMirror，消息区在输入框上方，与输入框同属一父容器
        const inputEl = document.querySelector(
          'textarea, [contenteditable="true"], .ProseMirror, [placeholder*="任务"], [placeholder*="提问"]'
        );
        const inputCard = inputEl?.closest('[class*="rounded"]') ?? inputEl?.parentElement?.parentElement;
        const inputRoot = inputCard ?? inputEl?.parentElement ?? inputEl;
        const notInInputArea = (el: Element) => !inputRoot?.contains(el);

        // 改进：直接获取页面文本，过滤掉 UI 元素后提取最新回复
        // Manus 回复格式: "思考过程" + 实际回复内容
        const fullText = document.body.innerText || '';
        const lines = fullText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

        // 跳过 UI 文本行，获取最新的助理回复
        const uiPatterns = [
          '新建任务', '所有任务', '项目', '库', '搜索', 'Ctrl', 'K',
          '开始免费试用', '免费计划', '分享', '积分',
          '我能为你做什么', '将您的工具连接到 Manus',
          '制作幻灯片', '创建网站', '开发应用', '设计', '更多',
          'Conversation Info', 'Lite', 'Manus', '效果如何',
          '下载 Manus', '任务完成时', '开启 Agent', '创建',
        ];

        // 倒序查找最近的助理回复（用户输入之后的第一条）
        let foundUserInput = false;
        let extractedText = '';
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i];
          const isUI = uiPatterns.some(p => line.includes(p));

          if (line.includes('say hello') || line.includes('test')) {
            foundUserInput = true;
            continue;
          }

          if (foundUserInput && !isUI && line.length > 5 && line.length < 3000) {
            extractedText = line;
            break;
          }
        }

        // 如果提取成功，直接返回
        if (extractedText && extractedText.length > 5) {
          const stopBtn = document.querySelector('[aria-label*="Stop"], [aria-label*="stop"]');
          const isStreaming = !!stopBtn;
          return { text: extractedText, isStreaming };
        }

        // 优先使用消息区：输入框卡片的 previousSibling（上方）或父容器内排除输入卡后的区域
        const messagesArea =
          inputCard?.previousElementSibling ??
          inputCard?.parentElement?.querySelector('[class*="overflow-auto"]') ??
          inputCard?.parentElement;
        const scoped = messagesArea ?? document.body;

        let text = "";
        const modelSelectors = [
          '[data-message-author="model"]',
          '[data-sender="assistant"]',
          '[data-role="assistant"]',
          '[class*="assistant"]',
          '[class*="model-response"]',
          '[class*="message-content"]',
          '[class*="Message"]',
          '[class*="response"]',
          '[class*="output"]',
          '[class*="bubble"]',
          '[class*="Bubble"]',
          "article",
          "[class*='markdown']",
          "[class*='prose']",
          '[class*="message"]',
          '[role="article"]',
        ];
        for (const sel of modelSelectors) {
          try {
            const els = scoped.querySelectorAll(sel);
            for (let i = els.length - 1; i >= 0; i--) {
              const el = els[i];
              if (!notInInputArea(el)) continue;
              const t = clean((el as HTMLElement).textContent ?? "");
              if (t.length >= 10 && !isSkip(t)) {
                text = t;
                break;
              }
            }
            if (text) break;
          } catch {
            /* selector may fail */
          }
        }

        if (!text) {
          const candidates: Array<{ el: Element; text: string; top: number }> = [];
          const allBlocks = scoped.querySelectorAll("p, div[class], li, pre, span[class], article");
          allBlocks.forEach((el) => {
            if (!notInInputArea(el)) return;
            const t = clean((el as HTMLElement).textContent ?? "");
            if (t.length > 15 && !isSkip(t) && !candidates.some((c) => c.text === t)) {
              const rect = (el as HTMLElement).getBoundingClientRect();
              if (rect.height > 0) candidates.push({ el, text: t, top: rect.top + rect.height });
            }
          });
          if (candidates.length > 0) {
            candidates.sort((a, b) => b.top - a.top);
            text = candidates[0].text;
          }
        }

        if (!text && inputCard?.parentElement) {
          const parent = inputCard.parentElement;
          const lastSubstantial = (p: Element): string => {
            const kids = Array.from(p.children);
            for (let i = kids.length - 1; i >= 0; i--) {
              const c = kids[i];
              if (inputRoot?.contains(c)) continue;
              const t = clean((c as HTMLElement).textContent ?? "");
              if (t.length > 15 && !isSkip(t)) return t;
              const nested = lastSubstantial(c);
              if (nested) return nested;
            }
            return "";
          };
          text = lastSubstantial(parent);
        }

        // 最后回退：按 Y 位置找输入框上方最下方的一块可见长文本（最后一条消息通常在输入框正上方）
        if (!text && inputEl) {
          const inputRect = (inputEl as HTMLElement).getBoundingClientRect();
          const aboveInput = (el: Element) => {
            const r = (el as HTMLElement).getBoundingClientRect();
            return r.bottom <= inputRect.top + 50;
          };
          const candidates: Array<{ text: string; bottom: number }> = [];
          document.querySelectorAll("p, div, article, li, pre, span").forEach((el) => {
            const t = clean((el as HTMLElement).textContent ?? "");
            if (t.length > 15 && !isSkip(t) && aboveInput(el)) {
              const r = (el as HTMLElement).getBoundingClientRect();
              if (r.height > 0 && r.width > 0) candidates.push({ text: t, bottom: r.bottom });
            }
          });
          if (candidates.length > 0) {
            candidates.sort((a, b) => b.bottom - a.bottom);
            text = candidates[0].text;
          }
        }

        const stopBtn = document.querySelector('[aria-label*="Stop"], [aria-label*="stop"]');
        const isStreaming = !!stopBtn;
        return { text, isStreaming };
      });

      // 最小 5 字（如 "Hello"），避免误抓 UI 文本
      const minLen = 5;
      if (result.text && result.text.length >= minLen) {
        if (result.text !== lastText) {
          lastText = result.text;
          stableCount = 0;
        } else {
          stableCount++;
          if (!result.isStreaming && stableCount >= 2) {
            break;
          }
        }
      }
    }

    if (!lastText) {
      const diag = await this.page.evaluate(() => {
        const input = document.querySelector(
          'textarea, [contenteditable="true"], .ProseMirror, [placeholder*="任务"], [placeholder*="提问"]'
        );
        const samples: string[] = [];
        document.querySelectorAll("p, div[class], article, [class*='message']").forEach((el, i) => {
          const t = ((el as HTMLElement).textContent ?? "").replace(/[\s\n]+/g, " ").trim().slice(0, 80);
          if (t.length > 10 && samples.length < 5) samples.push(t);
        });
        return {
          hasInput: !!input,
          url: window.location.href,
          samples,
        };
      });
      console.warn(
        "[Manus Web Browser] 回复检测失败诊断:",
        "hasInput=" + diag.hasInput,
        "url=" + diag.url,
        "samples=" + JSON.stringify(diag.samples)
      );
      throw new Error(
        "Manus DOM 模拟：未检测到回复。请确保 manus.im/app 页面已打开、已登录，且输入框可见。"
      );
    }

    const sseLine = `data: ${JSON.stringify({ text: lastText })}\n`;
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseLine));
        controller.close();
      },
    });
  }

  async chatCompletions(params: {
    conversationId?: string;
    message: string;
    model: string;
    signal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array>> {
    if (!this.page) {
      throw new Error("ManusWebClientBrowser not initialized");
    }

    const { message } = params;
    console.log("[Manus Web Browser] 使用 DOM 模拟发送消息...");

    return this.chatCompletionsViaDOM({
      message,
      signal: params.signal,
    });
  }

  async close(): Promise<void> {
    if (this.page) {
      await this.page.close();
      this.page = null;
    }
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    this.initialized = false;
  }
}
