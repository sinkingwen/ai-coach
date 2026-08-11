/**
 * Vercel Serverless Function：/api/chat
 * 处理前端对话请求，代理火山方舟 API 并流式转发
 *
 * Vercel 部署时：
 *   - 静态资源由 public/ 目录自动托管
 *   - /api/* 路由由本目录下对应文件处理
 *   - 环境变量在 Vercel 项目 Settings → Environment Variables 中配置
 */

const https = require('https'); // 内置 HTTPS 请求模块

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
 * 读取请求体（JSON）
 * 兼容 Vercel 预解析的 req.body 和原生流式读取
 * @param {object} req Vercel 请求对象
 * @returns {Promise<object>} 解析后的 JSON
 */
function readRequestBody(req) {
  // Vercel 可能已自动解析请求体到 req.body
  if (req.body && typeof req.body === 'object') {
    return Promise.resolve(req.body);
  }
  // 兜底：从原始流中读取
  return new Promise((resolve, reject) => {
    let chunks = ''; // 累积请求体数据
    req.on('data', (chunk) => { chunks += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(chunks || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Vercel Serverless 入口
 * @param {object} req 请求对象
 * @param {object} res 响应对象（支持流式写入）
 */
module.exports = async (req, res) => {
  // 标记响应是否已开始，防止重复 writeHead/end
  let responded = false;

  // 安全写入 SSE 错误事件（防止 res 已结束时崩溃）
  function safeWriteError(message, detail) {
    if (responded) return;
    responded = true;
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ message, detail })}\n\n`);
      res.end();
    } catch (e) {
      // 响应已关闭，忽略
    }
  }

  // 安全返回 JSON 错误
  function safeJsonError(status, payload) {
    if (responded) return;
    responded = true;
    try {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    } catch (e) {
      // 响应已关闭，忽略
    }
  }

  try {
    // 处理 CORS 预检请求
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      });
      res.end();
      return;
    }

    // 仅接受 POST 请求
    if (req.method !== 'POST') {
      safeJsonError(405, { error: '方法不允许' });
      return;
    }

    // 读取环境变量配置
    const apiKey = process.env.ARK_API_KEY;
    if (!apiKey) {
      safeJsonError(500, {
        error: '未配置 ARK_API_KEY 环境变量。请在 Vercel 项目 Settings → Environment Variables 中添加。'
      });
      return;
    }

    const model = process.env.ARK_MODEL || 'deepseek-v4-flash-260425';
    const host = process.env.ARK_HOST || 'ark.cn-beijing.volces.com';
    const apiPath = process.env.ARK_PATH || '/api/v3/responses';
    const temperature = parseFloat(process.env.TEMPERATURE || '0.6');
    // Vercel Hobby 计划上限 10 秒，超时设为 9 秒留余量
    const timeoutMs = parseInt(process.env.TIMEOUT_MS || '9000', 10);

    const body = await readRequestBody(req); // 读取并解析请求体
    const messages = Array.isArray(body.messages) ? body.messages : [];
    // 校验：消息列表不能为空
    if (messages.length === 0) {
      safeJsonError(400, { error: '消息不能为空' });
      return;
    }

    // 若调用方提供了自定义系统提示词则使用之，否则使用默认教练人设
    const instructions = body.systemPrompt || SYSTEM_PROMPT;

    // 构造火山方舟 Responses API 请求体
    const input = messages.map((msg) => ({
      role: msg.role,
      content: [{ type: 'input_text', text: msg.content }]
    }));

    const requestBody = JSON.stringify({
      model: model,
      stream: true,
      temperature: temperature,
      instructions: instructions,
      tools: [{ type: 'web_search', max_keyword: 3 }],
      input: input
    });

    // 构造发往火山方舟的 HTTPS 请求选项
    const options = {
      hostname: host,
      path: apiPath,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody)
      },
      timeout: timeoutMs
    };

    // 先告知前端：将以 SSE 形式流式返回
    responded = true;
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
          safeWriteError('上游接口返回错误', { status: arkRes.statusCode, detail: errBuf });
        });
        return;
      }

      // 200：直接把上游的 SSE 原始字节透传给前端
      arkRes.on('data', (chunk) => {
        try { res.write(chunk); } catch (e) { /* 响应已关闭 */ }
      });
      arkRes.on('end', () => {
        try { res.end(); } catch (e) { /* 响应已关闭 */ }
      });
    });

    // 监听超时：超时则中止请求
    arkReq.on('timeout', () => {
      arkReq.destroy();
      safeWriteError('请求超时');
    });

    // 监听请求错误（网络异常等）
    arkReq.on('error', (err) => {
      safeWriteError('请求火山方舟失败', err.message);
    });

    // 写入请求体并发送
    arkReq.write(requestBody);
    arkReq.end();

  } catch (err) {
    // 捕获所有未处理的异常，防止 FUNCTION_INVOCATION_FAILED
    safeJsonError(500, { error: '服务器内部错误', detail: err.message });
  }
};
