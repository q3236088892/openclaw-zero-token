# Web 登录与对话流程梳理

本文基于当前仓库代码梳理「自动登录」「手动抓包登录」以及「对话发送/接收」流程。涉及的实现主要在 `src/providers/*-web-*.ts` 与 `src/agents/*-web-stream.ts`。

**范围**
ChatGPT Web、Claude Web、DeepSeek Web、Qwen Web（国际版）、Qwen Web（国内版）、Doubao Web、Kimi Web、Gemini Web、Grok Web、GLM Web（chatglm.cn）、GLM 国际版（z.ai）。

**凭证存储位置与来源**
登录完成后会写入 `auth-profiles.json`，路径由 `src/agents/agent-paths.ts` 与 `src/agents/auth-profiles/paths.ts` 决定。使用仓库脚本启动时，默认会将 `OPENCLAW_STATE_DIR` 指向仓库根目录下的 `.openclaw-zero-state`，最终文件通常位于 `.openclaw-zero-state/agents/default/agent/auth-profiles.json`。写入逻辑在 `src/commands/onboard-auth.credentials.ts`。

## 自动登录（CDP/Playwright）

所有自动登录都通过 Playwright CDP 连接浏览器来完成，入口为各自的 `src/providers/*-web-auth.ts`。通用步骤如下：
1. 读取浏览器配置并解析 profile（`browser.attachOnly` / `browser.cdpUrl`）。
2. 连接 CDP（`chromium.connectOverCDP`），打开站点登录页。
3. 监听请求/响应或读取浏览器 cookies、localStorage 来提取必要凭证。
4. 返回给 onboarding 写入 `auth-profiles.json`。

对应实现文件：
`src/providers/chatgpt-web-auth.ts`  
`src/providers/claude-web-auth.ts`  
`src/providers/deepseek-web-auth.ts`  
`src/providers/doubao-web-auth.ts`  
`src/providers/gemini-web-auth.ts`  
`src/providers/grok-web-auth.ts`  
`src/providers/kimi-web-auth.ts`  
`src/providers/glm-web-auth.ts`  
`src/providers/glm-intl-web-auth.ts`  
`src/providers/qwen-web-auth.ts`  
`src/providers/qwen-cn-web-auth.ts`

## 手动抓包登录（Manual Paste）所需字段

下面列出「手动抓包」所需字段，来源为 `onboard-auth.credentials.ts` 以及各 provider 的 client 选项类型。

| 站点 | 必填字段 | 说明 |
| --- | --- | --- |
| ChatGPT Web | `cookie` | 主要使用 `__Secure-next-auth.session-token` cookie。 |
| Claude Web | `sessionKey`、`cookie` | `sessionKey` 需为 `sk-ant-sid01-*` 或 `sk-ant-sid02-*`。 |
| DeepSeek Web | `cookie`、`bearer`（可选） | `bearer` 可从请求头或页面存储中取。 |
| Qwen Web（国际） | `cookie` 或 `sessionToken` | 由 `qwen-web` 适配器使用。 |
| Qwen Web（国内） | `cookie`、`x-xsrf-token` | `ut` 会从 `b-user-id` cookie 派生。 |
| Doubao Web | `cookie` | 会解析出 `sessionid` 等字段。 |
| Kimi Web | `cookie` | 直接用于页面内请求。 |
| Gemini Web | `cookie` | 浏览器 DOM 模拟发送消息。 |
| Grok Web | `cookie` | API 或 DOM 模拟需要。 |
| GLM Web（chatglm.cn） | `cookie` | 由页面内请求读取刷新 token。 |
| GLM Intl（z.ai） | `cookie` | 由页面内请求读取刷新 token。 |

对应写入位置：`src/commands/onboard-auth.credentials.ts`  
对应 onboarding 选择逻辑：`src/commands/auth-choice.apply.*.ts`

## 对话发送与接收逻辑（按站点）

**ChatGPT Web**
对话发送路径在 `src/providers/chatgpt-web-client-browser.ts`。优先走 DOM 发送（模拟输入与点击发送）以规避风控，若可用则走后台 API。API 路径包含 `/backend-api/conversation/init`、`/backend-api/sentinel/chat-requirements/prepare`、`/backend-api/sentinel/chat-requirements/finalize`、`/backend-api/conversation`，并使用 `Accept: text/event-stream`。  
对话接收解析在 `src/agents/chatgpt-web-stream.ts`，解析 SSE `data:` 流并提取内容增量。

**Claude Web**
对话发送路径在 `src/providers/claude-web-client-browser.ts`。先请求 `/api/organizations` 获取组织，再 `POST /api/.../chat_conversations` 创建会话，随后 `POST /api/.../chat_conversations/{id}/completion` 获取 SSE。  
对话接收解析在 `src/agents/claude-web-stream.ts`，处理 SSE 并生成文本/工具调用事件。

**DeepSeek Web**
对话发送路径在 `src/providers/deepseek-web-client.ts`。先 `POST /api/v0/chat_session/create` 获取会话，再对 `/api/v0/chat/completion` 发送消息。请求前会调用 `/api/v0/chat/create_pow_challenge` 并计算 PoW，将结果放入 `x-ds-pow-response` 头。  
对话接收解析在 `src/agents/deepseek-web-stream.ts`，解析 SSE `event:`/`data:`，兼容多种字段（如 `data.v`、`data.content`、`choices[].delta`）。

**Qwen Web（国际版）**
对话发送路径在 `src/providers/qwen-web-client-browser.ts`。先 `POST /api/v2/chats/new` 获取 `chat_id`，再 `POST /api/v2/chat/completions?chat_id=...` 发送消息。  
对话接收解析在 `src/agents/qwen-web-stream.ts`，解析 SSE `data:` 并提取 `choices[].delta.content` 等字段。

**Qwen Web（国内版）**
对话发送路径在 `src/providers/qwen-cn-web-client-browser.ts`，请求 `https://chat2.qianwen.com/api/v2/chat`，URL 中包含 `biz_id=ai_qwen` 等参数，头部包含 `x-xsrf-token`、`x-deviceid`、`x-platform`。  
对话接收解析在 `src/agents/qwen-cn-web-stream.ts`，优先从 `data.data.messages[*].content` 提取内容，兼容其他字段。

**Doubao Web**
对话发送路径在 `src/providers/doubao-web-client-browser.ts`，请求 `https://www.doubao.com/samantha/chat/completion?...`，携带必要 query 参数与 `Origin/Referer`。  
对话接收解析在 `src/agents/doubao-web-stream.ts`，解析 SSE `data:` 并输出内容增量。

**Kimi Web**
对话发送路径在 `src/providers/kimi-web-client-browser.ts`，请求 `https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat`，在浏览器上下文中 `fetch`。  
对话接收解析在 `src/agents/kimi-web-stream.ts`，解析 SSE 并输出内容增量。

**Gemini Web**
对话发送在 `src/providers/gemini-web-client-browser.ts` 采用 DOM 模拟输入与点击发送，绕过复杂 RPC。  
对话接收通过轮询 DOM 获取最后一条助手回复并生成流，在 `src/agents/gemini-web-stream.ts` 中封装为标准事件。

**Grok Web**
对话发送在 `src/providers/grok-web-client-browser.ts`，优先尝试 `https://grok.com/rest/app-chat/...` 的 API 请求，遇到 403 会回退到 DOM 模拟。  
对话接收解析在 `src/agents/grok-web-stream.ts`，处理 SSE 或 DOM 轮询结果。

**GLM Web（chatglm.cn）**
对话发送在 `src/providers/glm-web-client-browser.ts`，构建 `X-Sign/X-Nonce/X-Timestamp` 签名头，使用站点接口并在浏览器上下文中请求。  
对话接收解析在 `src/agents/glm-web-stream.ts`，解析 SSE 并输出内容增量。

**GLM Intl（z.ai）**
对话发送在 `src/providers/glm-intl-web-client-browser.ts`，签名逻辑与国内版一致，目标域名为 `z.ai`。  
对话接收解析在 `src/agents/glm-intl-web-stream.ts`。

## 参考入口与调试定位

登录选择与手动抓包提示：`src/commands/auth-choice.apply.*.ts`  
凭证写入：`src/commands/onboard-auth.credentials.ts`  
请求发送：`src/providers/*-web-client*.ts`  
流式解析：`src/agents/*-web-stream.ts`
