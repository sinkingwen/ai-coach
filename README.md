# AI Life Coach（AI 人生教练）

一个基于火山方舟 DeepSeek-V4-flash 模型的 AI 人生教练网站。通过自然对话，AI 会倾听你的烦恼、给出建议、帮助你成长。

## 项目目标

让用户像和真人教练聊天一样，随时获得：
- 情绪倾听与共情陪伴
- 个人成长建议
- 目标拆解与行动方案
- 反思引导

## 技术栈

- **前端**：原生 HTML5 + CSS3 + JavaScript（不使用框架，符合 W3C 标准）
- **后端**：Node.js（仅使用内置 `http` / `https` 模块，零依赖）
- **部署**：Vercel（Serverless Function + 静态托管）
- **AI 模型**：火山方舟 DeepSeek-V4-flash（模型 ID 通过环境变量 `ARK_MODEL` 配置）
- **接口**：火山方舟 Responses API（流式 SSE 输出，域名/路径通过环境变量配置）

## 目录结构

```
life-coach/
├── AI Rules              # AI 开发规范说明
├── README.md             # 项目说明书（本文件）
├── server.js             # 本地开发服务器（静态服务 + API 代理）
├── package.json          # npm 脚本与元信息
├── vercel.json           # Vercel 部署配置（maxDuration 等）
├── .env.example          # 环境变量模板（复制为 .env 使用）
├── .gitignore            # 排除 .env / node_modules 等
├── api/
│   └── chat.js           # Vercel Serverless Function：/api/chat
├── lib/
│   └── arkProxy.js       # 共享逻辑：配置读取 + 火山方舟流式代理
└── public/               # 前端静态资源（Vercel 自动托管）
    ├── index.html        # 页面结构（语义化 HTML5）
    ├── css/
    │   └── style.css     # 样式（响应式、Flexbox/Grid、中文注释）
    └── js/
        └── app.js        # 前端逻辑（聊天交互、流式渲染）
```

## 页面说明

### 布局结构（左中右三栏）
- **顶部 Header**：标题"AI 人生教练"+ 副标题 + 服务状态点；移动端含历史/分析抽屉切换按钮
- **左栏 · 对话历史**：会话列表（标题 + 时间）、"新对话"按钮、单项删除
- **中栏 · 聊天区**：欢迎卡片与开场建议、消息流（用户靠右/教练靠左，流式逐字显示）、底部输入区（回车发送、Shift+回车换行、情绪选择按钮）
- **右栏 · 对话分析**：
  - 当前情绪：最近一条用户消息的情绪 emoji、标签、效价分值
  - 情绪分布：六类情绪（喜悦/平静/焦虑/悲伤/愤怒/困惑）占比条形图
  - 情绪趋势：SVG 面积图，横轴为消息序号、纵轴为情绪效价（-2~+2）
  - AI 深度分析：一键生成结构化报告（情绪模式/核心议题/积极信号/风险提示/行动建议）

### 数据与持久化
- 所有会话保存在浏览器 `localStorage`，刷新不丢失
- 每条用户消息在本地用关键词词典做情绪检测，结果用于分布与趋势
- 用户可点击情绪按钮主动表达感受，覆盖自动检测结果
- AI 深度分析复用 `/api/chat` 接口，传入自定义"分析师"系统提示词

## 快速开始

### 一、本地开发

1. **复制环境变量模板**
```bash
cp .env.example .env
```

2. **编辑 .env，填入你的 API Key**
```bash
# .env
ARK_API_KEY=ark-xxxxxxxxxxxxxxxxxxxxxxxx
```

3. **启动本地服务器**
```bash
node --env-file=.env server.js
# 或
npm start
```

4. **打开网页**
浏览器访问 `http://localhost:3000` 即可开始对话。

### 二、部署到 Vercel

1. **推送代码到 GitHub**（确保 `.env` 不会被提交，已在 `.gitignore` 中排除）

2. **在 Vercel 导入项目**
   - 访问 https://vercel.com/new
   - 选择你的 GitHub 仓库

3. **配置环境变量**（关键步骤，见下方"环境变量"小节）

4. **部署**：Vercel 会自动识别 `vercel.json` 与 `api/` 目录

5. **访问**：部署完成后通过 Vercel 分配的域名访问

## 环境变量

所有敏感信息与可配置项均通过环境变量管理，**不硬编码在源码中**。

### Vercel 配置位置
`Project Settings` → `Environment Variables` → 分别为 `Production` / `Preview` / `Development` 添加

### 变量清单

| 变量名 | 必填 | 说明 | 默认值 / 示例 |
|---|:---:|---|---|
| `ARK_API_KEY` | ✅ | 火山方舟 API Key | `ark-xxxxxxxx` |
| `ARK_MODEL` | ❌ | 模型 / 推理接入点 ID | `deepseek-v4-flash-260425` |
| `ARK_HOST` | ❌ | 接口域名 | `ark.cn-beijing.volces.com` |
| `ARK_PATH` | ❌ | 接口路径 | `/api/v3/responses` |
| `TEMPERATURE` | ❌ | 采样温度（0~2） | `0.6` |
| `TIMEOUT_MS` | ❌ | 请求超时（毫秒） | `60000` |
| `PORT` | ❌ | 本地开发端口（Vercel 忽略） | `3000` |

> 🔒 `ARK_API_KEY` 是密钥，仅在 Vercel 环境变量中填写，不要写入代码或提交到 git。

### 接口扩展
`POST /api/chat` 请求体支持可选字段 `systemPrompt`：
```json
{ "messages": [...], "systemPrompt": "自定义系统提示词（覆盖默认教练人设）" }
```
未传 `systemPrompt` 时使用内置的"人生教练"人设；AI 深度分析功能即通过传入"分析师"提示词复用此接口实现。

## Vercel 部署注意

- `vercel.json` 中 `api/chat.js` 的 `maxDuration` 设为 60 秒（Pro 计划上限）
  - Hobby（免费）计划 Serverless 函数上限为 10 秒，长对话可能超时
  - 如使用 Hobby 计划，建议将 `TIMEOUT_MS` 调小（如 9000）并接受长回复可能截断
- 静态资源由 `public/` 目录自动托管，无需额外配置
- 前端请求 `/api/chat` 会自动路由到 `api/chat.js`

## 优化建议（后续可做）

- 支持 Markdown / 代码块渲染
- 增加深色模式切换
- 增加语音输入（Web Speech API）
- 增加对话主题分类（情绪、职业、关系、目标等）
- 增加用户账户体系，实现跨设备会话同步
