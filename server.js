/**
 * AI Life Coach 后端服务器
 * 功能：
 *   1. 提供前端静态资源服务（public 目录）
 *   2. 代理火山方舟 DeepSeek-V4-flash API 请求，解决浏览器 CORS 问题
 *   3. 流式转发（SSE）AI 回复到前端
 * 仅使用 Node.js 内置模块，零依赖，无需 npm install
 */

const http = require('http');   // 内置 HTTP 服务模块
const https = require('https'); // 内置 HTTPS 请求模块
const fs = require('fs');       // 内置文件系统模块
const path = require('path');   // 内置路径处理模块

// ===== 配置项 =====
const PORT = process.env.PORT || 3000; // 服务监听端口，默认 3000
const PUBLIC_DIR = path.join(__dirname, 'public'); // 静态资源目录

// 火山方舟 API 配置
// 密钥从环境变量读取，避免硬编码泄露到 git 历史；启动前请设置 ARK_API_KEY
const ARK_API_KEY = process.env.ARK_API_KEY; // API Key（从环境变量读取）
if (!ARK_API_KEY) {
  console.error('[启动失败] 未检测到环境变量 ARK_API_KEY，请先设置：\n  export ARK_API_KEY=你的密钥\n或在项目根目录创建 .env 文件并通过 node --env-file=.env server.js 启动');
  process.exit(1);
}
const ARK_HOST = 'ark.cn-beijing.volces.com';                         // 接口域名
const ARK_PATH = '/api/v3/responses';                                 // 接口路径
const MODEL = 'deepseek-v4-flash-260425';                             // 模型标识
const TIMEOUT_MS = 60000;                                             // 请求超时 60 秒
const TEMPERATURE = 0.6;                                              // 采样温度 0.6

// ===== MIME 类型映射表（用于静态资源响应头） =====
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

/**
 * 系统提示词：定义 AI 的“人生教练”人设与行为规范
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
 * 工具函数：解析请求体（JSON）
 * @param {http.IncomingMessage} req 请求对象
 * @returns {Promise<object>} 解析后的 JSON 对象
 */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = ''; // 累积请求体数据
    req.on('data', (chunk) => { chunks += chunk; }); // 监听数据流
    req.on('end', () => {
      try {
        resolve(JSON.parse(chunks || '{}')); // 解析 JSON
      } catch (err) {
        reject(err); // 解析失败则拒绝
      }
    });
    req.on('error', reject); // 监听错误
  });
}

/**
 * 工具函数：发送 JSON 响应
 * @param {http.ServerResponse} res 响应对象
 * @param {number} statusCode HTTP 状态码
 * @param {object} data JSON 数据
 */
function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data); // 序列化为 JSON 字符串
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*' // 允许跨域
  });
  res.end(body);
}

/**
 * 工具函数：安全拼接静态文件路径，防止路径穿越攻击
 * @param {string} reqPath 请求路径
 * @returns {string|null} 安全的文件绝对路径，不安全则返回 null
 */
function safeJoinPath(reqPath) {
  // 去掉查询参数并解码
  const cleanPath = decodeURIComponent(reqPath.split('?')[0]);
  // 默认入口文件为 index.html
  const relativePath = cleanPath === '/' ? '/index.html' : cleanPath;
  const filePath = path.join(PUBLIC_DIR, relativePath);
  // 校验：最终路径必须位于静态资源目录内
  if (!filePath.startsWith(PUBLIC_DIR)) return null;
  return filePath;
}

/**
 * 处理静态资源请求
 * @param {http.ServerResponse} res 响应对象
 * @param {string} filePath 文件绝对路径
 */
function serveStaticFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // 文件不存在则返回 404
      sendJson(res, 404, { error: '资源不存在' });
      return;
    }
    // 根据扩展名设置 Content-Type
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'no-store' // 开发环境禁用缓存，确保改动即时生效
    });
    res.end(data);
  });
}

/**
 * 核心函数：代理火山方舟 API 并流式转发响应
 * @param {http.ServerResponse} res 前端响应对象
 * @param {Array} messages 对话历史 [{role, content}]
 * @param {string} [systemPrompt] 可选的系统提示词，覆盖默认教练人设（用于深度分析等场景）
 */
function proxyArkStream(res, messages, systemPrompt) {
  // 若调用方提供了自定义系统提示词则使用之，否则使用默认教练人设
  const instructions = systemPrompt || SYSTEM_PROMPT;

  // 构造火山方舟 Responses API 请求体
  // input 数组：承载多轮对话历史，每条消息含 role 与 content 数组
  const input = messages.map((msg) => ({
    role: msg.role, // user / assistant
    content: [{ type: 'input_text', text: msg.content }] // 内容文本
  }));

  const requestBody = JSON.stringify({
    model: MODEL,                 // 模型标识
    stream: true,                 // 开启流式输出
    temperature: TEMPERATURE,     // 采样温度 0.6
    instructions: instructions,   // 系统级指令（教练人设或自定义）
    tools: [{ type: 'web_search', max_keyword: 3 }], // 启用联网搜索工具
    input: input                  // 多轮对话历史
  });

  // 构造发往火山方舟的 HTTPS 请求选项
  const options = {
    hostname: ARK_HOST,
    path: ARK_PATH,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ARK_API_KEY}`,        // 鉴权
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(requestBody) // 请求体字节长度
    },
    timeout: TIMEOUT_MS // 60 秒超时
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

  // 监听超时：60 秒无响应则中止
  arkReq.on('timeout', () => {
    arkReq.destroy(); // 中止请求
    res.write(`event: error\ndata: ${JSON.stringify({ message: '请求超时（60秒）' })}\n\n`);
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

/**
 * 创建 HTTP 服务器主入口
 */
const server = http.createServer(async (req, res) => {
  // 处理预检请求（CORS preflight）
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  // 路由：对话接口 POST /api/chat
  if (req.method === 'POST' && req.url === '/api/chat') {
    try {
      const body = await readRequestBody(req); // 读取并解析请求体
      const messages = Array.isArray(body.messages) ? body.messages : [];
      // 校验：消息列表不能为空
      if (messages.length === 0) {
        sendJson(res, 400, { error: '消息不能为空' });
        return;
      }
      // 代理并流式转发（传入可选的自定义系统提示词）
      proxyArkStream(res, messages, body.systemPrompt);
    } catch (err) {
      sendJson(res, 400, { error: '请求体解析失败', detail: err.message });
    }
    return;
  }

  // 其余 GET 请求：当作静态资源处理
  if (req.method === 'GET') {
    const filePath = safeJoinPath(req.url);
    if (!filePath) {
      sendJson(res, 403, { error: '非法路径' });
      return;
    }
    serveStaticFile(res, filePath);
    return;
  }

  // 其他方法不允许
  sendJson(res, 405, { error: '方法不允许' });
});

// 启动服务器并监听端口
server.listen(PORT, () => {
  console.log(`✅ AI 人生教练服务已启动：http://localhost:${PORT}`);
});
