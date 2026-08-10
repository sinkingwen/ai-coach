/**
 * Vercel Serverless Function：/api/chat
 * 处理前端对话请求，代理火山方舟 API 并流式转发
 *
 * Vercel 部署时：
 *   - 静态资源由 public/ 目录自动托管
 *   - /api/* 路由由本目录下对应文件处理
 *   - 环境变量在 Vercel 项目 Settings → Environment Variables 中配置
 */

const { proxyArkStream } = require('../lib/arkProxy');

/**
 * 读取请求体（JSON）
 * @param {object} req Vercel 请求对象
 * @returns {Promise<object>} 解析后的 JSON
 */
function readRequestBody(req) {
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
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '方法不允许' }));
    return;
  }

  try {
    const body = await readRequestBody(req); // 读取并解析请求体
    const messages = Array.isArray(body.messages) ? body.messages : [];
    // 校验：消息列表不能为空
    if (messages.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '消息不能为空' }));
      return;
    }
    // 代理并流式转发（传入可选的自定义系统提示词）
    proxyArkStream(res, messages, body.systemPrompt);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '请求体解析失败', detail: err.message }));
  }
};
