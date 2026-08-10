/**
 * 火山方舟 API 代理共享模块
 * 被 api/chat.js（Vercel Serverless）与 server.js（本地开发）共同复用
 * 所有敏感与可配置项均从环境变量读取，禁止硬编码
 */

const https = require('https'); // 内置 HTTPS 请求模块

/**
 * 读取配置：全部来自 process.env，带默认值
 * 这样本地开发与 Vercel 部署使用同一套配置源
 */
function getConfig() {
  // API Key：必须项，缺失则调用方应直接返回错误
  const apiKey = process.env.ARK_API_KEY;
  // 模型 / 推理接入点 ID（火山方舟控制台创建后获得）
  const model = process.env.ARK_MODEL || 'deepseek-v4-flash-260425';
  // 接口域名与路径
  const host = process.env.ARK_HOST || 'ark.cn-beijing.volces.com';
  const apiPath = process.env.ARK_PATH || '/api/v3/responses';
  // 采样温度：控制输出随机性，0.6 兼顾稳定与多样
  const temperature = parseFloat(process.env.TEMPERATURE || '0.6');
  // 请求超时（毫秒），Vercel Serverless 需小于平台 maxDuration
  const timeoutMs = parseInt(process.env.TIMEOUT_MS || '60000', 10);
  return { apiKey, model, host, apiPath, temperature, timeoutMs };
}

/**
 * 系统提示词：定义 AI 的"人生教练"人设与行为规范
 * 使其温暖、共情、善于引导，并给出可执行建议
 */
const SYSTEM_PROMPT = [
  '你是一位专业、温暖、富有同理心的 AI 人生教练（Life Coach）。',
  '你的使命是通过真诚的对话，帮助用户理清思绪、发现自身力量、制定可行行动方案，从而持续成长。',
  '请遵循以下原则：',
  '1. 先倾听与共情：在给建议前，先复述并确认你理解了用户的感受，让用户感到被看见、被接纳。',
  '2. 提问优先：用开放且有启发性的问题，引导用户自我反思，而不是直接灌输答案。',
  '3. 建议具体可执行：当给出建议时，拆解成小而清晰的下一步行动，避免空泛口号。',
  '4. 正向且不评判：保持鼓励与尊重，即使面对用户的负面情绪或失败经历，也不批评、不羞辱。',
  '5. 篇幅适中：回答简洁有重点，避免长篇大论；必要时使用分点或短段落提升可读性。',
  '6. 边界意识：遇到明显的心理健康危机（如自伤倾向），温和建议用户寻求专业心理援助。',
  '请始终用简体中文回答，语气像一位值得信赖的朋友。'
].join('\n');

/**
 * 校验配置是否完整（API Key 必填）
 * @param {object} config getConfig() 返回的配置
 * @returns {{ok: boolean, error: string|null}}
 */
function validateConfig(config) {
  if (!config.apiKey) {
    return {
      ok: false,
      error: '未配置 ARK_API_KEY 环境变量。请在 Vercel 项目 Settings → Environment Variables 中添加，或本地创建 .env 文件。'
    };
  }
  return { ok: true, error: null };
}

/**
 * 核心函数：代理火山方舟 API 并流式转发响应
 * 兼容 Node.js 原生 http.ServerResponse（本地）与 Vercel Serverless res
 * @param {object} res 响应对象（需支持 writeHead/write/end）
 * @param {Array} messages 对话历史 [{role, content}]
 * @param {string} [systemPrompt] 可选的自定义系统提示词
 */
function proxyArkStream(res, messages, systemPrompt) {
  const config = getConfig();
  const valid = validateConfig(config);
  if (!valid.ok) {
    // 配置缺失：返回 JSON 错误（尚未切换到 SSE 流）
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: valid.error }));
    return;
  }

  // 若调用方提供了自定义系统提示词则使用之，否则使用默认教练人设
  const instructions = systemPrompt || SYSTEM_PROMPT;

  // 构造火山方舟 Responses API 请求体
  // input 数组：承载多轮对话历史，每条消息含 role 与 content 数组
  const input = messages.map((msg) => ({
    role: msg.role, // user / assistant
    content: [{ type: 'input_text', text: msg.content }] // 内容文本
  }));

  const requestBody = JSON.stringify({
    model: config.model,              // 模型 / 推理接入点 ID
    stream: true,                     // 开启流式输出
    temperature: config.temperature,  // 采样温度
    instructions: instructions,       // 系统级指令（教练人设或自定义）
    tools: [{ type: 'web_search', max_keyword: 3 }], // 启用联网搜索工具
    input: input                      // 多轮对话历史
  });

  // 构造发往火山方舟的 HTTPS 请求选项
  const options = {
    hostname: config.host,
    path: config.apiPath,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,        // 鉴权
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(requestBody)   // 请求体字节长度
    },
    timeout: config.timeoutMs // 超时控制
  };

  // 先告知前端：将以 SSE 形式流式返回
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  // 发起对火山方舟的请求
  const arkReq = https.request(options, (arkRes) => {
    // 若火山方舟返回非 200，读取错误体并回传给前端
    if (arkRes.statusCode !== 200) {
      let errBuf = '';
      arkRes.on('data', (c) => { errBuf += c; });
      arkRes.on('end', () => {
        // 以 SSE 错误事件形式通知前端
        res.write(`event: error\ndata: ${JSON.stringify({ message: '上游接口返回错误', status: arkRes.statusCode, detail: errBuf })}\n\n`);
        res.end();
      });
      return;
    }

    // 200：直接把上游的 SSE 原始字节透传给前端
    // 前端自行解析 event: / data: 行
    arkRes.on('data', (chunk) => {
      res.write(chunk); // 透传数据块
    });
    arkRes.on('end', () => {
      res.end(); // 上游结束则关闭前端响应
    });
  });

  // 监听超时：超时则中止请求
  arkReq.on('timeout', () => {
    arkReq.destroy(); // 中止请求
    res.write(`event: error\ndata: ${JSON.stringify({ message: '请求超时' })}\n\n`);
    res.end();
  });

  // 监听请求错误（网络异常等）
  arkReq.on('error', (err) => {
    res.write(`event: error\ndata: ${JSON.stringify({ message: '请求火山方舟失败', detail: err.message })}\n\n`);
    res.end();
  });

  // 写入请求体并发送
  arkReq.write(requestBody);
  arkReq.end();
}

module.exports = {
  getConfig,
  validateConfig,
  SYSTEM_PROMPT,
  proxyArkStream
};
