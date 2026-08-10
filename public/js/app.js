/**
 * AI 人生教练 - 前端逻辑
 * 职责：
 *   1. 多会话管理（新建 / 切换 / 删除），持久化到 localStorage
 *   2. 聊天交互：提交输入、流式渲染教练回复、多轮上下文
 *   3. 本地情绪检测：基于关键词词典对每条用户消息打分
 *   4. 对话分析面板：当前情绪、情绪分布、SVG 趋势图
 *   5. AI 深度分析：复用 /api/chat，传入分析师系统提示词
 *   6. 移动端抽屉式侧栏切换
 */

(function () {
  'use strict';

  // ===== localStorage 存储键 =====
  const STORAGE_KEY = 'life_coach_conversations_v1';

  // ===== 情绪词典：每种情绪对应关键词与效价分值（正=积极，负=消极） =====
  // valence 用于趋势图：喜悦最高、悲伤/愤怒最低
  const EMOTIONS = {
    joy:      { label: '喜悦', emoji: '😊', color: 'var(--joy)',      valence:  2, keywords: ['开心','高兴','快乐','幸福','兴奋','愉快','喜欢','感谢','谢谢','笑','哈哈','嘿嘿','棒','赞','期待','满足'] },
    calm:     { label: '平静', emoji: '😌', color: 'var(--calm)',     valence:  1, keywords: ['平静','放松','安心','舒服','稳定','还好','正常','好的','没事','释然','平和'] },
    anxiety:  { label: '焦虑', emoji: '😰', color: 'var(--anxiety)',  valence: -1, keywords: ['焦虑','紧张','担心','害怕','恐惧','压力','不安','忐忑','慌','烦躁','焦躁','害怕'] },
    sadness:  { label: '悲伤', emoji: '😢', color: 'var(--sadness)',  valence: -2, keywords: ['难过','伤心','悲伤','哭','痛苦','失落','孤独','失望','沮丧','心碎','emo','低落'] },
    anger:    { label: '愤怒', emoji: '😠', color: 'var(--anger)',    valence: -2, keywords: ['生气','愤怒','烦','讨厌','气','怒','恼','爆发','受够','烦死','可恶'] },
    confusion:{ label: '困惑', emoji: '🤔', color: 'var(--confusion)',valence: -1, keywords: ['迷茫','困惑','不知道','不懂','纠结','矛盾','犹豫','茫然','搞不清','纠结','没方向'] }
  };

  // ===== DOM 元素引用 =====
  const form = document.getElementById('inputForm');
  const userInput = document.getElementById('userInput');
  const sendBtn = document.getElementById('sendBtn');
  const messagesEl = document.getElementById('messages');
  const chatArea = document.getElementById('chatArea');
  const welcome = document.getElementById('welcome');
  const suggestionsEl = document.getElementById('suggestions');
  const emotionPicker = document.getElementById('emotionPicker'); // 情绪选择按钮容器

  // 左栏：历史
  const newChatBtn = document.getElementById('newChatBtn');
  const historyList = document.getElementById('historyList');
  const historyEmpty = document.getElementById('historyEmpty');

  // 右栏：分析
  const emotionEmoji = document.getElementById('emotionEmoji');
  const emotionLabel = document.getElementById('emotionLabel');
  const emotionValence = document.getElementById('emotionValence');
  const emotionDist = document.getElementById('emotionDist');
  const emotionTrend = document.getElementById('emotionTrend');
  const analyzeBtn = document.getElementById('analyzeBtn');
  const analysisResult = document.getElementById('analysisResult');

  // 移动端抽屉
  const toggleHistory = document.getElementById('toggleHistory');
  const toggleAnalysis = document.getElementById('toggleAnalysis');
  const historyPanel = document.getElementById('historyPanel');
  const analysisPanel = document.getElementById('analysisPanel');
  const overlay = document.getElementById('overlay');

  // ===== 应用状态 =====
  // conversations: 会话数组，每条结构：
  //   { id, title, createdAt, updatedAt, messages: [{role, content, emotion, ts}], analysis }
  let conversations = [];
  let currentId = null;     // 当前会话 id
  let isResponding = false; // 是否正在等待 AI 回复
  let selectedEmotion = null; // 用户手动选择的情绪 key（null 表示未选，走自动检测）

  /* ============================================================
     工具函数
     ============================================================ */

  /**
   * 生成唯一 id（时间戳 + 随机串）
   */
  function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /**
   * HTML 转义，防止 XSS
   */
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  /**
   * 格式化时间为“MM-DD HH:mm”
   */
  function formatTime(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /**
   * 获取当前会话对象
   */
  function currentConv() {
    return conversations.find((c) => c.id === currentId) || null;
  }

  /* ============================================================
     本地情绪检测
     ============================================================ */

  /**
   * 对一段文本进行情绪打分
   * @param {string} text 用户消息文本
   * @returns {{primary:string, scores:Object, valence:number}}
   *   primary: 主情绪 key（无匹配时为 'calm' 中性）
   *   scores: 各情绪命中次数
   *   valence: 主情绪效价分值
   */
  function detectEmotion(text) {
    const scores = {};
    let total = 0;
    // 遍历每种情绪的关键词，统计命中次数
    for (const key of Object.keys(EMOTIONS)) {
      let count = 0;
      for (const kw of EMOTIONS[key].keywords) {
        // 统计关键词出现次数（indexOf 循环兼容性好）
        let idx = text.indexOf(kw);
        while (idx !== -1) {
          count++;
          idx = text.indexOf(kw, idx + kw.length);
        }
      }
      scores[key] = count;
      total += count;
    }

    // 无任何关键词命中：视为中性平静
    if (total === 0) {
      return { primary: 'calm', scores, valence: EMOTIONS.calm.valence };
    }

    // 取命中次数最多的情绪作为主情绪
    let primary = 'calm';
    let max = 0;
    for (const key of Object.keys(EMOTIONS)) {
      if (scores[key] > max) {
        max = scores[key];
        primary = key;
      }
    }
    return { primary, scores, valence: EMOTIONS[primary].valence };
  }

  /* ============================================================
     情绪选择按钮（手动表达感受，覆盖自动检测）
     ============================================================ */

  /**
   * 渲染情绪选择按钮行（基于 EMOTIONS 词典，单一数据源）
   */
  function renderEmotionPicker() {
    emotionPicker.innerHTML = '';
    Object.keys(EMOTIONS).forEach((key) => {
      const em = EMOTIONS[key];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `emo-btn emo-${key}`;
      btn.dataset.emo = key;
      btn.title = '选择当前感受：' + em.label;
      btn.innerHTML = `<span class="emo-emoji">${em.emoji}</span><span>${em.label}</span>`;
      btn.addEventListener('click', () => selectEmotion(key));
      emotionPicker.appendChild(btn);
    });
  }

  /**
   * 选择/取消选择一个情绪（再次点击同一项取消）
   * @param {string} key 情绪 key
   */
  function selectEmotion(key) {
    selectedEmotion = (selectedEmotion === key) ? null : key;
    updateEmotionPickerUI();
    previewCurrentEmotion();
  }

  /**
   * 刷新情绪按钮的选中态样式
   */
  function updateEmotionPickerUI() {
    emotionPicker.querySelectorAll('.emo-btn').forEach((btn) => {
      if (btn.dataset.emo === selectedEmotion) btn.classList.add('selected');
      else btn.classList.remove('selected');
    });
  }

  /**
   * 预览当前情绪：若已手动选择，立即在右栏“当前情绪”展示；
   * 未选则恢复为基于对话数据的显示
   */
  function previewCurrentEmotion() {
    if (selectedEmotion) {
      const em = EMOTIONS[selectedEmotion];
      emotionEmoji.textContent = em.emoji;
      emotionLabel.textContent = em.label + '（已选）';
      emotionValence.textContent = '效价 ' + em.valence;
    } else {
      renderAnalysis(); // 恢复为基于最近一条用户消息的显示
    }
  }

  /**
   * 清空情绪选择（发送后调用）
   */
  function clearEmotionSelection() {
    selectedEmotion = null;
    updateEmotionPickerUI();
  }

  /* ============================================================
     持久化：localStorage 读写
     ============================================================ */

  /**
   * 保存所有会话到 localStorage
   */
  function saveConversations() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
    } catch (e) {
      console.warn('[Life Coach] 保存失败：', e);
    }
  }

  /**
   * 从 localStorage 加载会话
   */
  function loadConversations() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) conversations = arr;
      }
    } catch (e) {
      console.warn('[Life Coach] 加载失败：', e);
      conversations = [];
    }
  }

  /* ============================================================
     会话管理
     ============================================================ */

  /**
   * 新建会话并切换过去
   */
  function createConversation() {
    const conv = {
      id: genId(),
      title: '新对话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      analysis: ''
    };
    conversations.unshift(conv); // 新会话放最前
    currentId = conv.id;
    saveConversations();
    clearEmotionSelection(); // 新对话清空情绪选择，保持干净状态
    renderHistory();
    renderChat();
    renderAnalysis();
    userInput.focus();
  }

  /**
   * 切换到指定会话
   */
  function switchConversation(id) {
    if (isResponding) return; // 响应中禁止切换，避免流错乱
    currentId = id;
    saveConversations();
    clearEmotionSelection(); // 切换会话清空情绪选择
    renderHistory();
    renderChat();
    renderAnalysis();
    closeDrawers(); // 移动端切换后收起抽屉
  }

  /**
   * 删除指定会话
   */
  function deleteConversation(id) {
    const idx = conversations.findIndex((c) => c.id === id);
    if (idx === -1) return;
    conversations.splice(idx, 1);
    // 若删除的是当前会话，则切换到首个或新建
    if (currentId === id) {
      currentId = conversations.length ? conversations[0].id : null;
      if (!currentId) {
        createConversation();
        return;
      }
    }
    saveConversations();
    renderHistory();
    renderChat();
    renderAnalysis();
  }

  /* ============================================================
     渲染：左栏历史列表
     ============================================================ */
  function renderHistory() {
    historyList.innerHTML = '';
    if (conversations.length === 0) {
      historyEmpty.style.display = 'block';
      return;
    }
    historyEmpty.style.display = 'none';

    conversations.forEach((conv) => {
      const li = document.createElement('li');
      li.className = 'history-item' + (conv.id === currentId ? ' active' : '');
      li.dataset.id = conv.id;

      const title = document.createElement('div');
      title.className = 'history-title';
      title.textContent = conv.title || '新对话';

      const time = document.createElement('div');
      time.className = 'history-time';
      time.textContent = formatTime(conv.updatedAt || conv.createdAt);

      // 删除按钮
      const del = document.createElement('button');
      del.className = 'history-del';
      del.title = '删除对话';
      del.textContent = '×';
      del.addEventListener('click', (e) => {
        e.stopPropagation(); // 阻止冒泡触发切换
        if (confirm('确定删除这个对话吗？')) {
          deleteConversation(conv.id);
        }
      });

      li.appendChild(title);
      li.appendChild(time);
      li.appendChild(del);
      li.addEventListener('click', () => switchConversation(conv.id));
      historyList.appendChild(li);
    });
  }

  /* ============================================================
     渲染：中栏聊天消息
     ============================================================ */
  function renderChat() {
    messagesEl.innerHTML = '';
    const conv = currentConv();
    // 无会话或空会话：显示欢迎卡片
    if (!conv || conv.messages.length === 0) {
      welcome.style.display = '';
      return;
    }
    welcome.style.display = 'none'; // 有消息则隐藏欢迎卡

    conv.messages.forEach((msg) => {
      if (msg.role === 'assistant') {
        // 教练消息：用可折叠气泡渲染思考过程 + 正文
        const coach = makeCoachBubble();
        if (msg.reasoning) coach.setReasoning(msg.reasoning); // 历史回放：先填思考（展开）
        if (msg.content) coach.setAnswer(msg.content);       // 再填正文（首次调用会折叠思考）
        if (!msg.content) coach.setAnswer('（无回复内容）');  // 兜底
      } else {
        // 用户消息：普通气泡 + 情绪小标签
        const bubble = createBubble('user', msg.content);
        if (msg.emotion) attachEmotionTag(bubble, msg.emotion);
      }
    });
    scrollToBottom();
  }

  /**
   * 创建一条消息气泡并返回气泡元素
   */
  function createBubble(role, text) {
    const wrap = document.createElement('div');
    wrap.className = `msg msg-${role}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = escapeHtml(text || '');
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    scrollToBottom();
    return bubble;
  }

  /**
   * 创建教练气泡：含“正在输入”指示器、可折叠思考区、正文区
   * 思考区在推理流式时展开、正文开始时自动折叠
   * @returns {{bubble:HTMLElement, setReasoning:(t:string)=>void, setAnswer:(t:string)=>void, getReasoning:()=>string, getAnswer:()=>string}}
   */
  function makeCoachBubble() {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-coach';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    // 初始显示“正在输入”三点动画
    bubble.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    scrollToBottom();

    let thinkingEl = null;       // <details> 思考容器
    let thinkingContent = null;  // 思考正文 <div>
    let answerEl = null;         // 回复正文 <div>
    let structureReady = false;  // 是否已清空 typing 指示器
    let firstAnswer = true;      // 是否还未开始正文

    // 清空 typing 指示器，准备真实内容结构
    function ensureStructure() {
      if (structureReady) return;
      structureReady = true;
      bubble.innerHTML = '';
    }

    // 更新思考过程文本（流式）
    function setReasoning(text) {
      ensureStructure();
      if (!thinkingEl) {
        thinkingEl = document.createElement('details');
        thinkingEl.className = 'thinking';
        thinkingEl.open = true; // 思考中默认展开
        const summary = document.createElement('summary');
        summary.className = 'thinking-summary';
        summary.textContent = '思考过程';
        thinkingContent = document.createElement('div');
        thinkingContent.className = 'thinking-content';
        thinkingEl.appendChild(summary);
        thinkingEl.appendChild(thinkingContent);
        bubble.appendChild(thinkingEl);
      }
      thinkingContent.innerHTML = escapeHtml(text);
      scrollToBottom();
    }

    // 更新正文文本（流式）；首次调用时自动折叠思考区
    function setAnswer(text) {
      ensureStructure();
      if (firstAnswer) {
        firstAnswer = false;
        if (thinkingEl) thinkingEl.open = false; // 正文开始 → 折叠思考
        answerEl = document.createElement('div');
        answerEl.className = 'answer-content';
        bubble.appendChild(answerEl);
      }
      answerEl.innerHTML = escapeHtml(text);
      scrollToBottom();
    }

    return {
      bubble,
      setReasoning,
      setAnswer,
      getReasoning: () => (thinkingContent ? thinkingContent.textContent : ''),
      getAnswer: () => (answerEl ? answerEl.textContent : '')
    };
  }

  function scrollToBottom() {
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  function autoResize() {
    userInput.style.height = 'auto';
    userInput.style.height = Math.min(userInput.scrollHeight, 140) + 'px';
  }

  /* ============================================================
     渲染：右栏对话分析
     ============================================================ */
  function renderAnalysis() {
    const conv = currentConv();
    // 统计用户消息
    const userMsgs = conv ? conv.messages.filter((m) => m.role === 'user') : [];

    // —— 当前情绪 ——
    if (userMsgs.length === 0) {
      emotionEmoji.textContent = '—';
      emotionLabel.textContent = '暂无数据';
      emotionValence.textContent = '';
    } else {
      const last = userMsgs[userMsgs.length - 1];
      const em = EMOTIONS[last.emotion ? last.emotion.primary : 'calm'];
      emotionEmoji.textContent = em.emoji;
      emotionLabel.textContent = em.label;
      emotionValence.textContent = '效价 ' + (last.emotion ? last.emotion.valence : 1);
    }

    // —— 情绪分布 ——
    renderDistribution(userMsgs);

    // —— 情绪趋势 ——
    renderTrend(userMsgs);

    // —— AI 深度分析结果 ——
    if (conv && conv.analysis) {
      analysisResult.textContent = conv.analysis;
    } else {
      analysisResult.innerHTML = '<p class="empty-hint">基于当前对话，AI 会给出情绪模式、核心议题与建议</p>';
    }
  }

  /**
   * 渲染情绪分布条形图
   */
  function renderDistribution(userMsgs) {
    if (userMsgs.length === 0) {
      emotionDist.innerHTML = '<p class="empty-hint">开始对话后这里会显示情绪占比</p>';
      return;
    }
    // 汇总每条用户消息的主情绪
    const counts = {};
    for (const key of Object.keys(EMOTIONS)) counts[key] = 0;
    userMsgs.forEach((m) => {
      const k = m.emotion ? m.emotion.primary : 'calm';
      counts[k] = (counts[k] || 0) + 1;
    });
    const total = userMsgs.length;

    let html = '';
    for (const key of Object.keys(EMOTIONS)) {
      const em = EMOTIONS[key];
      const cnt = counts[key] || 0;
      const pct = total ? Math.round((cnt / total) * 100) : 0;
      html += `
        <div class="dist-row">
          <span class="dist-dot" style="background:${em.color}"></span>
          <span class="dist-name">${em.label}</span>
          <span class="dist-bar-wrap"><span class="dist-bar" style="width:${pct}%;background:${em.color}"></span></span>
          <span class="dist-count">${cnt}</span>
        </div>`;
    }
    emotionDist.innerHTML = html;
  }

  /**
   * 渲染情绪趋势 SVG 面积图
   * 横轴：用户消息序号；纵轴：效价（-2 ~ +2）
   */
  function renderTrend(userMsgs) {
    if (userMsgs.length < 2) {
      emotionTrend.innerHTML = '<p class="empty-hint">至少 2 条消息后显示趋势</p>';
      return;
    }
    const w = 280, h = 90, padX = 10, padY = 14;
    const minV = -2, maxV = 2;
    const vals = userMsgs.map((m) => (m.emotion ? m.emotion.valence : 1));
    const n = vals.length;

    // 计算各点坐标
    const pts = vals.map((v, i) => {
      const x = padX + (n === 1 ? 0 : (i / (n - 1)) * (w - 2 * padX));
      const y = padY + (1 - (v - minV) / (maxV - minV)) * (h - 2 * padY);
      return [x, y];
    });

    // 折线路径
    const linePath = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
    // 面积路径（闭合到底部）
    const areaPath = linePath +
      ` L ${pts[n - 1][0].toFixed(1)},${h - padY}` +
      ` L ${pts[0][0].toFixed(1)},${h - padY} Z`;

    // 零基线 y 坐标（效价=0）
    const zeroY = padY + (1 - (0 - minV) / (maxV - minV)) * (h - 2 * padY);

    // 构造 SVG（含渐变填充、零基线、数据点）
    const svg = `
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="情绪趋势图">
        <defs>
          <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#6c5ce7" stop-opacity="0.35"/>
            <stop offset="100%" stop-color="#6c5ce7" stop-opacity="0.02"/>
          </linearGradient>
        </defs>
        <line x1="${padX}" y1="${zeroY.toFixed(1)}" x2="${w - padX}" y2="${zeroY.toFixed(1)}" stroke="rgba(108,92,231,0.25)" stroke-dasharray="3 3"/>
        <path d="${areaPath}" fill="url(#trendGrad)"/>
        <path d="${linePath}" fill="none" stroke="#6c5ce7" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        ${pts.map((p) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.6" fill="#fff" stroke="#6c5ce7" stroke-width="1.5"/>`).join('')}
      </svg>
      <div class="trend-legend"><span>较早</span><span>最近</span></div>`;
    emotionTrend.innerHTML = svg;
  }

  /* ============================================================
     SSE 流解析：从响应流中提取增量文本
     ============================================================ */

  /**
   * 从一条 SSE 数据对象中提取增量文本
   * 兼容火山方舟 Responses API 的多种事件结构
   */
  function extractDeltaText(data) {
    if (!data || typeof data !== 'object') return '';
    if (typeof data.delta === 'string') return data.delta;             // Responses API：delta 为字符串
    if (data.delta && typeof data.delta.text === 'string') return data.delta.text;
    if (Array.isArray(data.choices) && data.choices[0]) {              // Chat Completions 兼容
      const d = data.choices[0].delta;
      if (d && typeof d.content === 'string') return d.content;
    }
    if (data.item && data.item.content && data.item.content[0]) {
      const c = data.item.content[0];
      if (typeof c.text === 'string') return c.text;
      if (typeof c.output_text === 'string') return c.output_text;
    }
    return '';
  }

  /**
   * 判断一条 SSE 事件是否属于“推理/思考”内容
   * 火山方舟 Responses API 用 response.reasoning_summary_text.delta 等事件承载思考过程
   * @param {string} eventName 事件名
   * @param {object} parsed 解析后的数据对象
   * @returns {boolean}
   */
  function isReasoningEvent(eventName, parsed) {
    const name = eventName || (parsed && parsed.type) || '';
    return typeof name === 'string' && name.indexOf('response.reasoning') === 0;
  }

  /**
   * 通用流式请求：向 /api/chat 发送消息，分别回调推理与正文增量
   * @param {Array} messages 对话历史
   * @param {string} [systemPrompt] 可选自定义系统提示词
   * @param {{onReasoning?:Function, onAnswer?:Function}} [cbs] 回调对象
   *   onReasoning(accReasoning) / onAnswer(accAnswer) 均传入累积文本
   * @returns {Promise<{reasoning:string, answer:string}>} 完整推理与正文
   */
  async function streamChat(messages, systemPrompt, cbs) {
    const onReasoning = cbs && cbs.onReasoning;
    const onAnswer = cbs && cbs.onAnswer;

    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(systemPrompt ? { messages, systemPrompt } : { messages })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${errText}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';      // 未解析缓冲区
    let reasoning = '';   // 累积推理文本
    let answer = '';      // 累积正文文本

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 事件以空行分隔
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        const lines = rawEvent.split('\n');
        let eventName = '';
        let dataStr = '';
        for (const line of lines) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
        }

        if (eventName === 'error') {
          let msg = 'AI 服务返回错误';
          try { msg = JSON.parse(dataStr).message || msg; } catch (_) {}
          throw new Error(msg);
        }
        if (dataStr === '[DONE]') { buffer = ''; break; }

        if (dataStr) {
          try {
            const parsed = JSON.parse(dataStr);
            const delta = extractDeltaText(parsed);
            if (delta) {
              // 按事件类型分流：推理事件进 reasoning，其余进 answer
              if (isReasoningEvent(eventName, parsed)) {
                reasoning += delta;
                onReasoning && onReasoning(reasoning);
              } else {
                answer += delta;
                onAnswer && onAnswer(answer);
              }
            }
          } catch (_) { /* 忽略非 JSON 行 */ }
        }
      }
    }
    return { reasoning, answer };
  }

  /* ============================================================
     发送用户消息
     ============================================================ */
  async function sendMessage(userText) {
    if (isResponding) return;
    const text = userText.trim();
    if (!text) return;

    // 确保存在当前会话
    let conv = currentConv();
    if (!conv) {
      createConversation();
      conv = currentConv();
    }

    // 情绪：优先使用手动选择，否则自动检测；标记 source 便于后续区分与上下文注入
    const emotion = selectedEmotion
      ? { primary: selectedEmotion, valence: EMOTIONS[selectedEmotion].valence, source: 'manual', scores: {} }
      : { ...detectEmotion(text), source: 'auto' };

    // 隐藏欢迎卡，渲染用户气泡（带情绪标签）
    welcome.style.display = 'none';
    const userBubble = createBubble('user', text);
    attachEmotionTag(userBubble, emotion);

    // 写入会话历史
    conv.messages.push({ role: 'user', content: text, emotion, ts: Date.now() });
    // 首条用户消息作为会话标题
    if (conv.messages.filter((m) => m.role === 'user').length === 1) {
      conv.title = text.length > 22 ? text.slice(0, 22) + '…' : text;
    }
    conv.updatedAt = Date.now();

    // 发给后端的对话历史：手动选择的情绪作为上下文前缀注入，让教练感知用户当下感受
    const payload = conv.messages.map((m) => {
      if (m.role === 'user' && m.emotion && m.emotion.source === 'manual') {
        const label = EMOTIONS[m.emotion.primary] ? EMOTIONS[m.emotion.primary].label : m.emotion.primary;
        return { role: 'user', content: `（我现在的感受：${label}）${m.content}` };
      }
      return { role: m.role, content: m.content };
    });

    // 显示教练气泡（含可折叠思考区）
    const coach = makeCoachBubble();
    let reasoningText = '';
    let answerText = '';

    isResponding = true;
    sendBtn.disabled = true;
    saveConversations();
    renderHistory();
    renderAnalysis();

    try {
      const result = await streamChat(payload, null, {
        onReasoning: (t) => { reasoningText = t; coach.setReasoning(t); },
        onAnswer: (t) => { answerText = t; coach.setAnswer(t); }
      });

      if (answerText.trim() === '') {
        // 正文为空时的兜底提示
        coach.setAnswer(reasoningText.trim() === ''
          ? '（教练暂时没有回复内容，请稍后再试）'
          : '（思考已完成，但未生成正文回复）');
      } else {
        // 写入教练回复（含思考过程，便于历史回放时折叠展示）
        conv.messages.push({
          role: 'assistant',
          content: answerText,
          reasoning: reasoningText || '',
          ts: Date.now()
        });
        conv.updatedAt = Date.now();
      }
    } catch (err) {
      coach.setAnswer('⚠️ ' + (err.message || '请求失败，请稍后重试'));
      console.error('[Life Coach] 请求失败：', err);
    } finally {
      isResponding = false;
      sendBtn.disabled = false;
      saveConversations();
      renderHistory();
      clearEmotionSelection(); // 清空情绪选择，准备下一条
      renderAnalysis();        // 刷新右栏（当前情绪恢复为已发送消息的情绪）
      userInput.focus();
    }
  }

  /**
   * 给用户气泡右上角附加情绪 emoji 小标签
   */
  function attachEmotionTag(bubble, emotion) {
    const em = EMOTIONS[emotion.primary];
    if (!em) return;
    const tag = document.createElement('span');
    tag.title = '检测情绪：' + em.label;
    tag.textContent = em.emoji;
    tag.style.cssText = 'position:absolute;right:-6px;top:-8px;font-size:13px;background:#fff;border-radius:50%;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.15);';
    bubble.style.position = 'relative';
    bubble.appendChild(tag);
  }

  /* ============================================================
     AI 深度分析
     ============================================================ */
  async function generateAnalysis() {
    const conv = currentConv();
    if (!conv || conv.messages.length === 0) {
      alert('当前对话还没有内容，先和教练聊聊吧');
      return;
    }
    if (isResponding) return;

    // 分析师系统提示词：要求结构化输出情绪模式、核心议题、建议
    const analystPrompt = [
      '你是一位资深的心理与对话分析师。请基于以下用户与人生教练的对话记录，给出一份简洁的深度分析报告。',
      '请严格按以下结构输出（使用纯文本，不要使用 Markdown 代码块）：',
      '【情绪模式】用 2-3 句话总结用户整体的情绪走向与波动。',
      '【核心议题】用要点列出用户关注的主要议题（最多 3 条）。',
      '【积极信号】指出对话中体现的用户优势或积极变化。',
      '【风险提示】如有负面情绪或潜在风险，简要提醒。',
      '【行动建议】给出 2-3 条具体可执行的下一步建议。',
      '全文控制在 300 字以内，语气专业温暖。'
    ].join('\n');

    // 构造请求：把对话记录作为内容交给分析师
    const transcript = conv.messages
      .map((m) => (m.role === 'user' ? '用户' : '教练') + '：' + m.content)
      .join('\n');
    const analyzeMessages = [{ role: 'user', content: '以下是对话记录，请据此分析：\n\n' + transcript }];

    // 进入加载状态
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = '分析中…';
    analysisResult.innerHTML = '<span class="analysis-loading"><span></span><span></span><span></span></span>';

    try {
      const result = await streamChat(analyzeMessages, analystPrompt, {
        onAnswer: (acc) => { analysisResult.textContent = acc; }
      });
      conv.analysis = result.answer || '（分析结果为空）';
      analysisResult.textContent = conv.analysis;
      saveConversations();
    } catch (err) {
      analysisResult.innerHTML = '<span style="color:#ef5b5b">⚠️ ' + escapeHtml(err.message || '分析失败') + '</span>';
    } finally {
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = '生成深度分析';
    }
  }

  /* ============================================================
     移动端抽屉控制
     ============================================================ */
  function openDrawer(panel) {
    panel.classList.add('open');
    overlay.hidden = false;
  }
  function closeDrawers() {
    historyPanel.classList.remove('open');
    analysisPanel.classList.remove('open');
    overlay.hidden = true;
  }

  /* ============================================================
     事件绑定
     ============================================================ */
  // 表单提交
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = userInput.value;
    if (!text.trim()) return;
    sendMessage(text);
    userInput.value = '';
    autoResize();
  });

  // 回车发送 / Shift+回车换行
  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  userInput.addEventListener('input', autoResize);

  // 建议问题点击
  suggestionsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.suggestion-btn');
    if (!btn) return;
    sendMessage(btn.textContent);
  });

  // 新对话
  newChatBtn.addEventListener('click', () => {
    if (isResponding) return;
    createConversation();
  });

  // 深度分析
  analyzeBtn.addEventListener('click', generateAnalysis);

  // 移动端抽屉切换
  toggleHistory.addEventListener('click', () => {
    const willOpen = !historyPanel.classList.contains('open');
    closeDrawers();
    if (willOpen) openDrawer(historyPanel);
  });
  toggleAnalysis.addEventListener('click', () => {
    const willOpen = !analysisPanel.classList.contains('open');
    closeDrawers();
    if (willOpen) openDrawer(analysisPanel);
  });
  overlay.addEventListener('click', closeDrawers);

  /* ============================================================
     初始化
     ============================================================ */
  renderEmotionPicker(); // 渲染情绪选择按钮
  loadConversations();
  if (conversations.length === 0) {
    createConversation(); // 首次访问自动建一个空会话
  } else {
    currentId = conversations[0].id; // 默认选中最近的会话
    renderHistory();
    renderChat();
    renderAnalysis();
  }
  userInput.focus();
})();
