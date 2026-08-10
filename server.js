/**
 * AI Life Coach 本地开发服务器
 * 功能：
 *   1. 提供前端静态资源服务（public 目录）
 *   2. 代理火山方舟 DeepSeek API 请求（/api/chat），复用 lib/arkProxy 共享逻辑
 *   3. 流式转发（SSE）AI 回复到前端
 *
 * 仅用于本地开发，生产环境请部署到 Vercel（api/chat.js 自动接管 /api/chat 路由）
 * 启动方式：
 *   node --env-file=.env server.js
 * 或：
 *   export ARK_API_KEY=你的密钥 && node server.js
 *
 * 仅使用 Node.js 内置模块，零依赖，无需 npm install
 */

const http = require('http');   // 内置 HTTP 服务模块
const fs = require('fs');       // 内置文件系统模块
const path = require('path');   // 内置路径处理模块
const { proxyArkStream, validateConfig, getConfig } = require('./lib/arkProxy'); // 共享代理逻辑

// ===== 配置项 =====
const PORT = process.env.PORT || 3000; // 服务监听端口，默认 3000
const PUBLIC_DIR = path.join(__dirname, 'public'); // 静态资源目录

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
 * 工具函数：发送 JSON 响应
 * @param {http.ServerResponse} res 响应对象
 * @param {number} statusCode HTTP 状态码
 * @param {object} data JSON 数据
 */
function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

/**
 * 工具函数：读取请求体（JSON）
 * @param {http.IncomingMessage} req 请求对象
 * @returns {Promise<object>} 解析后的 JSON 对象
 */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = '';
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
 * 工具函数：安全拼接静态文件路径，防止路径穿越攻击
 * @param {string} reqPath 请求路径
 * @returns {string|null} 安全的文件绝对路径，不安全则返回 null
 */
function safeJoinPath(reqPath) {
  const cleanPath = decodeURIComponent(reqPath.split('?')[0]);
  const relativePath = cleanPath === '/' ? '/index.html' : cleanPath;
  const filePath = path.join(PUBLIC_DIR, relativePath);
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
      sendJson(res, 404, { error: '资源不存在' });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'no-store' // 开发环境禁用缓存
    });
    res.end(data);
  });
}

// 启动前校验配置：缺失 API Key 时给出清晰提示
const configCheck = validateConfig(getConfig());
if (!configCheck.ok) {
  console.error('\n[启动失败]', configCheck.error);
  console.error('\n本地开发请创建 .env 文件：');
  console.error('  ARK_API_KEY=你的密钥');
  console.error('  ARK_MODEL=deepseek-v4-flash-260425   # 可选，默认值已提供');
  console.error('\n然后用以下命令启动：');
  console.error('  node --env-file=.env server.js\n');
  process.exit(1);
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

  // 路由：对话接口 POST /api/chat（复用共享代理逻辑）
  if (req.method === 'POST' && req.url === '/api/chat') {
    try {
      const body = await readRequestBody(req);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (messages.length === 0) {
        sendJson(res, 400, { error: '消息不能为空' });
        return;
      }
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

  sendJson(res, 405, { error: '方法不允许' });
});

// 启动服务器并监听端口
server.listen(PORT, () => {
  console.log(`✅ AI 人生教练服务已启动：http://localhost:${PORT}`);
  console.log('   提示：生产环境请部署到 Vercel，详见 README.md');
});
