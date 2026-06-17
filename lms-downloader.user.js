// ==UserScript==
// @name         LMS 实验报告终端复制助手
// @namespace    https://github.com/lsn-crawler
// @version      2026.06.17.8
// @description  在 LMS/Canvas 作业页为实验报告、代码块和命令块增加「复制到终端」按钮；点击后自动复制到浏览器剪贴板，同时尝试自动打开平台「剪贴板」弹窗并写入、点确定，最后在虚拟机终端按 Ctrl+Shift+V 即可粘贴；兼容脚本猫。
// @author       TRAE
// @match        http://10.30.0.135/*
// @match        https://10.30.0.135/*
// @match        *://*/*xterm*
// @match        *://*/*terminal*
// @match        *://*/*shell*
// @match        *://*/*ttyd*
// @match        *://*/*wetty*
// @match        *://*/*gotty*
// @run-at       document-idle
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
  'use strict';

  const STYLE_ID = 'lms-terminal-copy-style';
  const TOOLBAR_ID = 'lms-terminal-copy-toolbar';
  const PROCESSED_ATTR = 'data-lms-terminal-copy-ready';

  const SELECTORS = {
    content: [
      '#assignment_show',
      '#assignment_description',
      '.assignment-description',
      '.user_content',
      '#content',
      'main',
      '[role="main"]'
    ].join(','),
    copyTargets: [
      'pre',
      'code',
      '.highlight',
      '.user_content pre',
      '.user_content code',
      '.assignment-description pre',
      '.assignment-description code',
      'textarea'
    ].join(',')
  };

  function ready(callback) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', callback, { once: true });
      return;
    }
    callback();
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .lms-terminal-copy-wrapper {
        position: relative !important;
      }

      .lms-terminal-copy-button,
      .lms-terminal-copy-toolbar button {
        border: 1px solid #1f6feb;
        border-radius: 6px;
        background: #1f6feb;
        color: #fff;
        cursor: pointer;
        font-size: 12px;
        line-height: 1.4;
        padding: 5px 9px;
        box-shadow: 0 1px 2px rgba(0, 0, 0, .15);
        z-index: 2147483647;
      }

      .lms-terminal-copy-button:hover,
      .lms-terminal-copy-toolbar button:hover {
        background: #1158c7;
        border-color: #1158c7;
      }

      .lms-terminal-copy-button {
        position: absolute;
        top: 6px;
        right: 6px;
      }

      .lms-terminal-copy-toolbar {
        position: fixed;
        right: 18px;
        bottom: 18px;
        display: flex;
        gap: 8px;
        align-items: center;
        padding: 8px;
        border-radius: 10px;
        background: rgba(255, 255, 255, .94);
        border: 1px solid rgba(31, 111, 235, .2);
        box-shadow: 0 8px 24px rgba(0, 0, 0, .18);
        z-index: 2147483647;
      }

      .lms-terminal-copy-toast {
        position: fixed;
        right: 18px;
        bottom: 76px;
        max-width: min(420px, calc(100vw - 36px));
        padding: 10px 12px;
        border-radius: 8px;
        background: #111827;
        color: #fff;
        font-size: 13px;
        line-height: 1.5;
        box-shadow: 0 8px 24px rgba(0, 0, 0, .2);
        z-index: 2147483647;
      }
    `;
    document.head.appendChild(style);
  }

  function showToast(message) {
    const oldToast = document.querySelector('.lms-terminal-copy-toast');
    if (oldToast) oldToast.remove();

    const toast = document.createElement('div');
    toast.className = 'lms-terminal-copy-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    window.setTimeout(() => {
      toast.remove();
    }, 2200);
  }

  function getVisibleText(element) {
    if (!element) return '';

    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      return element.value || '';
    }

    // 不走克隆，直接用原始元素的 textContent，
    // 但排除所有已知的脚本按钮文字。
    const btnTexts = [
      '复制到终端', '复制选中内容', '复制并打开剪贴板',
      '写入平台剪贴板', '送入虚拟机剪贴板', '直接发送到网页终端',
      '复制实验报告命令'
    ];
    let text = element.textContent || '';
    btnTexts.forEach((btn) => {
      text = text.split(btn).join('');     // 字符串级剔除，不依赖 DOM
    });
    return text.trim() ? text : (element.innerText || element.textContent || '');
  }

  function normalizeForTerminal(rawText) {
    return String(rawText || '')
      .replace(/\r\n?/g, '\n')
      .replace(/\u00a0/g, ' ')
      .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
      .replace(/复制到终端|复制选中内容|复制并打开剪贴板|写入平台剪贴板|送入虚拟机剪贴板|直接发送到网页终端|复制实验报告命令/g, '')
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/[：]/g, ':')
      .replace(/[；]/g, ';')
      .replace(/[，]/g, ',')
      .replace(/[（]/g, '(')
      .replace(/[）]/g, ')')
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/g, ''))
      .filter((line) => ![
        '复制到终端',
        '复制选中内容',
        '复制并打开剪贴板',
        '写入平台剪贴板',
        '送入虚拟机剪贴板',
        '直接发送到网页终端',
        '复制实验报告命令'
      ].includes(line.trim()))
      .join('\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();
  }

  function getAccessibleDocuments() {
    const docs = [document];
    const iframes = document.querySelectorAll('iframe');
    iframes.forEach((iframe) => {
      try {
        const innerDoc = iframe.contentDocument;
        if (innerDoc && innerDoc !== document) {
          docs.push(innerDoc);
        }
      } catch (error) {
        // 跨域 iframe 无法访问，直接忽略
      }
    });
    return docs;
  }

  function isOwnUiNode(node) {
    return Boolean(
      node &&
      node.closest &&
      (
        node.closest(`#${TOOLBAR_ID}`) ||
        node.closest('.lms-terminal-copy-wrapper') ||
        node.closest('.lms-terminal-copy-toast')
      )
    );
  }

  function isVisibleElement(node) {
    if (!node || !node.getBoundingClientRect) return false;
    const style = node.ownerDocument.defaultView.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findXtermTextarea(doc) {
    const candidates = doc.querySelectorAll('.xterm-helper-textarea, textarea.xterm-helper-textarea');
    for (const node of candidates) {
      if (node && node instanceof HTMLTextAreaElement) {
        return node;
      }
    }
    return null;
  }

  function findGenericTerminalInput(doc) {
    const selectors = [
      '.terminal textarea',
      '.terminal input',
      '.term textarea',
      '#terminal textarea',
      '#terminal input',
      'textarea[aria-label*="terminal" i]',
      'textarea[aria-label*="shell" i]',
      'textarea[aria-label*="终端"]',
      'textarea[name*="terminal" i]',
      'textarea[id*="terminal" i]',
      '[contenteditable="true"][class*="terminal" i]',
      '[contenteditable="true"][class*="xterm" i]',
      '[contenteditable="true"][class*="shell" i]'
    ];
    for (const selector of selectors) {
      const node = doc.querySelector(selector);
      if (node) return node;
    }
    return null;
  }

  function dispatchInputEvents(target, value) {
    try {
      target.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertFromPaste', data: value }));
    } catch (error) {
      // 旧浏览器可能不支持 InputEvent
    }
    try {
      target.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertFromPaste', data: value }));
    } catch (error) {
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
    try {
      target.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (error) {
      // ignore
    }
  }

  function dispatchPasteEvent(target, value) {
    try {
      const data = new DataTransfer();
      data.setData('text/plain', value);
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data
      });
      // 部分实现不会在构造时挂载 clipboardData，需要再写一次
      try { Object.defineProperty(pasteEvent, 'clipboardData', { value: data }); } catch (_) { /* ignore */ }
      return target.dispatchEvent(pasteEvent);
    } catch (error) {
      return false;
    }
  }

  function pasteIntoXterm(textarea, value) {
    try {
      textarea.focus();
      // xterm.js 监听 textarea 的 input 事件并据此向终端写入
      const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
      const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
      if (setter) {
        setter.call(textarea, value);
      } else {
        textarea.value = value;
      }
      dispatchInputEvents(textarea, value);
      // 同时尝试派发 paste 事件以兼容部分基于 paste 的实现
      dispatchPasteEvent(textarea, value);
      return true;
    } catch (error) {
      console.warn('[LMS Terminal Copy] 写入 xterm textarea 失败。', error);
      return false;
    }
  }

  function pasteIntoTextLikeElement(element, value) {
    try {
      element.focus();
      if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
        const proto = element instanceof HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
        if (setter) {
          setter.call(element, value);
        } else {
          element.value = value;
        }
        dispatchInputEvents(element, value);
        dispatchPasteEvent(element, value);
        return true;
      }
      if (element.isContentEditable) {
        const ok = document.execCommand && document.execCommand('insertText', false, value);
        if (!ok) {
          element.textContent = (element.textContent || '') + value;
          dispatchInputEvents(element, value);
        }
        dispatchPasteEvent(element, value);
        return true;
      }
    } catch (error) {
      console.warn('[LMS Terminal Copy] 写入网页终端输入框失败。', error);
    }
    return false;
  }

  async function pasteIntoWebTerminal(value) {
    // 1) 优先尝试通过实验平台右侧的「剪贴板」面板把内容送入虚拟机系统剪贴板
    const bridged = await pasteIntoLabPlatformClipboard(value);
    if (bridged) {
      return true;
    }

    const docs = getAccessibleDocuments();
    for (const doc of docs) {
      const xtermTextarea = findXtermTextarea(doc);
      if (xtermTextarea && pasteIntoXterm(xtermTextarea, value)) {
        return true;
      }
    }
    for (const doc of docs) {
      const generic = findGenericTerminalInput(doc);
      if (generic && pasteIntoTextLikeElement(generic, value)) {
        return true;
      }
    }
    // 最后再试一次：取页面活动元素，避免错过自定义实现
    const active = document.activeElement;
    if (active && (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement || active.isContentEditable)) {
      if (pasteIntoTextLikeElement(active, value)) return true;
    }
    return false;
  }

  // ===== 在线实验平台「剪贴板」桥 =====
  // 目标：自动打开平台「剪贴板」弹窗 → 写入命令 → 点「确定」，
  // 平台会把内容同步进虚拟机系统剪贴板，用户只需在虚拟机终端 Ctrl+Shift+V。

  function logDebug(...args) {
    console.log('[LMS剪贴板桥]', ...args);
  }

  // 遍历所有可访问的文档（含同源 iframe、Shadow DOM）
  function getAllRoots() {
    const roots = [];
    const visited = new WeakSet();

    function walk(root) {
      if (!root || visited.has(root)) return;
      visited.add(root);
      roots.push(root);

      // 同源 iframe
      const iframes = root.querySelectorAll ? root.querySelectorAll('iframe') : [];
      iframes.forEach((iframe) => {
        try { if (iframe.contentDocument) walk(iframe.contentDocument); } catch (_) {}
      });

      // Shadow DOM
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      all.forEach((el) => {
        if (el.shadowRoot) walk(el.shadowRoot);
      });
    }

    walk(document);
    return roots;
  }

  // 在所有根节点中找包含关键词的可见可点击元素
  function findClipboardOpener() {
    const roots = getAllRoots();
    const keywords = ['剪贴板', '剪切板', 'Clipboard', 'clipboard'];
    logDebug('搜索剪贴板按钮，共', roots.length, '个根节点');

    for (const root of roots) {
      const all = root.querySelectorAll ? root.querySelectorAll('button, a, [role="button"], li, span, div, label, [tabindex]') : [];
      for (const el of all) {
        if (isOwnUiNode(el)) continue;
        const text = (el.innerText || el.textContent || '').trim();
        if (!text || text.length > 50) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        for (const kw of keywords) {
          if (text === kw || text.includes(kw)) {
            logDebug('找到剪贴板按钮:', text, el.tagName, el.className?.substring(0, 60));
            return el;
          }
        }
      }
    }
    logDebug('未找到剪贴板按钮');
    return null;
  }

  // 在所有根节点中找弹窗/模态框里的 textarea
  function findClipboardTextarea() {
    const roots = getAllRoots();

    // 策略1：弹窗里的 textarea
    const dialogSelectors = [
      '[role="dialog"]', '.modal', '.ant-modal', '.el-dialog',
      '.layui-layer', '.ivu-modal', '.dialog', '.popup',
      '[class*="dialog"]', '[class*="modal"]', '[class*="popup"]',
      '[class*="overlay"]', '[class*="drawer"]', '[class*="mask"]'
    ];
    for (const root of roots) {
      if (!root.querySelectorAll) continue;
      for (const sel of dialogSelectors) {
        try {
          const dialogs = root.querySelectorAll(sel);
          for (const dlg of dialogs) {
            const ta = dlg.querySelector('textarea');
            if (ta && !isOwnUiNode(ta) && isVisibleElement(ta)) {
              logDebug('在弹窗里找到 textarea:', ta.className?.substring(0, 60));
              return ta;
            }
          }
        } catch (_) {}
      }
    }

    // 策略2：取最大的可见 textarea
    let best = null, bestArea = 0;
    for (const root of roots) {
      if (!root.querySelectorAll) continue;
      const textareas = root.querySelectorAll('textarea');
      for (const ta of textareas) {
        if (isOwnUiNode(ta) || !isVisibleElement(ta)) continue;
        const rect = ta.getBoundingClientRect();
        if (rect.width < 80 || rect.height < 30) continue;
        const area = rect.width * rect.height;
        if (area > bestArea) { bestArea = area; best = ta; }
      }
    }
    if (best) logDebug('取最大可见 textarea:', best.className?.substring(0, 60), bestArea);
    else logDebug('未找到任何 textarea');
    return best;
  }

  // 找「确定」按钮
  function findConfirmButton() {
    const roots = getAllRoots();
    const confirmKeywords = ['确定', 'OK', '确认', 'Apply', 'Send', 'Sync', '提交'];
    for (const root of roots) {
      if (!root.querySelectorAll) continue;
      // 先只在弹窗容器里找
      const dialogSel = '[role="dialog"], .modal, .ant-modal, .el-dialog, .layui-layer, .ivu-modal, .dialog, .popup, [class*="dialog"], [class*="modal"], [class*="popup"], [class*="overlay"]';
      try {
        const dialogs = root.querySelectorAll(dialogSel);
        for (const dlg of dialogs) {
          const btns = dlg.querySelectorAll('button, [role="button"]');
          for (const btn of btns) {
            const text = (btn.innerText || '').trim();
            if (confirmKeywords.includes(text)) {
              logDebug('在弹窗找到确定按钮:', text);
              return btn;
            }
          }
        }
      } catch (_) {}
    }
    // 兜底：全页面找最靠右的确定按钮
    let best = null, bestLeft = -1;
    for (const root of roots) {
      if (!root.querySelectorAll) continue;
      const btns = root.querySelectorAll('button, [role="button"]');
      for (const btn of btns) {
        if (isOwnUiNode(btn)) continue;
        const text = (btn.innerText || '').trim();
        if (text === '确定' || text === 'OK') {
          const left = btn.getBoundingClientRect().left;
          if (left > bestLeft) { bestLeft = left; best = btn; }
        }
      }
    }
    if (best) logDebug('全页面找到确定按钮');
    return best;
  }

  // 写入 textarea 并派发事件，多策略尝试
  function writeToTextarea(textarea, value) {
    if (!textarea) return false;
    try {
      // React 等框架监听 value setter 和 input 事件
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, 'value'
      );
      if (nativeSetter && nativeSetter.set) {
        nativeSetter.set.call(textarea, value);
      } else {
        textarea.value = value;
      }
      // 派发所有可能的事件
      textarea.dispatchEvent(new Event('focus', { bubbles: true }));
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      textarea.dispatchEvent(new Event('blur', { bubbles: true }));
      textarea.setSelectionRange(value.length, value.length);
      logDebug('已写入 textarea', value.length, '字符');
      return true;
    } catch (e) {
      logDebug('写入 textarea 失败:', e.message);
      return false;
    }
  }

  // 主流程：打开剪贴板 → 写入 → 点确定
  async function pasteIntoLabPlatformClipboard(value) {
    // 先看弹窗是否已经打开
    let textarea = findClipboardTextarea();
    let needOpen = !textarea;

    if (needOpen) {
      const opener = findClipboardOpener();
      if (!opener) {
        logDebug('没找到剪贴板按钮，跳过平台桥接');
        return false;
      }
      logDebug('点击剪贴板按钮');
      opener.click();
      // 轮询等待弹窗里的 textarea 出现（最多 3 秒）
      const start = Date.now();
      while (!textarea && Date.now() - start < 3000) {
        await new Promise(r => setTimeout(r, 150));
        textarea = findClipboardTextarea();
      }
    }

    if (!textarea) {
      logDebug('仍未找到 textarea，放弃');
      return false;
    }

    // 写入内容
    if (!writeToTextarea(textarea, value)) return false;

    // 点确定
    await new Promise(r => setTimeout(r, 100));
    const confirmBtn = findConfirmButton();
    if (confirmBtn) {
      logDebug('点击确定按钮');
      confirmBtn.click();
      logDebug('剪贴板桥完成！现在去虚拟机终端按 Ctrl+Shift+V 粘贴');
    } else {
      logDebug('未找到确定按钮，但内容已写入 textarea，请手动点确定');
    }

    return true;
  }

  async function copyToBrowserClipboard(value) {
    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(value, 'text');
        return true;
      }
    } catch (_) {}
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (_) {}
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.left = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }

  async function copyText(text) {
    const normalizedText = normalizeForTerminal(text);
    if (!normalizedText) {
      showToast('没有可复制的内容');
      return false;
    }

    const clipboardOk = await copyToBrowserClipboard(normalizedText);
    const pasted = await pasteIntoWebTerminal(normalizedText);

    if (pasted && clipboardOk) {
      showToast(`已复制并自动写入剪贴板（${normalizedText.length} 字符），在终端 Ctrl+Shift+V 粘贴`);
      return true;
    }
    if (pasted) {
      showToast(`已自动写入剪贴板（${normalizedText.length} 字符），在终端 Ctrl+Shift+V 粘贴`);
      return true;
    }
    if (clipboardOk) {
      showToast(`已复制（${normalizedText.length} 字符），在终端 Ctrl+Shift+V 粘贴`);
      return true;
    }

    showToast('复制失败，请检查脚本猫剪贴板权限');
    return false;
  }

  async function copyTextToClipboardOnly(text) {
    const normalizedText = normalizeForTerminal(text);
    if (!normalizedText) {
      showToast('没有可复制的内容');
      return false;
    }

    const clipboardOk = await copyToBrowserClipboard(normalizedText);
    const platformOk = await pasteIntoLabPlatformClipboard(normalizedText);

    if (clipboardOk && platformOk) {
      showToast(`已复制并自动写入剪贴板（${normalizedText.length} 字符），在终端 Ctrl+Shift+V 粘贴`);
      return true;
    }
    if (clipboardOk) {
      showToast(`已复制（${normalizedText.length} 字符），在终端 Ctrl+Shift+V 粘贴`);
      return true;
    }
    if (platformOk) {
      showToast(`已自动写入剪贴板（${normalizedText.length} 字符），在终端 Ctrl+Shift+V 粘贴`);
      return true;
    }

    showToast('复制失败，请检查脚本猫剪贴板权限');
    return false;
  }

  function createCopyButton(label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lms-terminal-copy-button';
    button.textContent = label;
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await onClick();
    });
    return button;
  }

  function enhanceBlock(block) {
    if (!block || block.getAttribute(PROCESSED_ATTR) === '1') return;
    if (block.closest('.lms-terminal-copy-wrapper')) return;
    if (block.tagName === 'CODE' && block.closest('pre')) return;
    if (!getVisibleText(block).trim()) return;

    block.setAttribute(PROCESSED_ATTR, '1');

    const parent = block.parentElement;
    if (!parent) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'lms-terminal-copy-wrapper';

    parent.insertBefore(wrapper, block);
    wrapper.appendChild(block);

    const button = createCopyButton('复制到终端', () => copyTextToClipboardOnly(getVisibleText(block)));
    wrapper.appendChild(button);
  }

  function findMainContent() {
    return document.querySelector(SELECTORS.content) || document.body;
  }

  function collectReportText() {
    const mainContent = findMainContent();
    const blocks = Array.from(mainContent.querySelectorAll('pre, code, textarea'))
      .map(getVisibleText)
      .map(normalizeForTerminal)
      .filter(Boolean);

    if (blocks.length > 0) {
      return blocks.join('\n\n');
    }

    return getVisibleText(mainContent);
  }

  function createToolbar() {
    if (document.getElementById(TOOLBAR_ID)) return;

    const toolbar = document.createElement('div');
    toolbar.id = TOOLBAR_ID;
    toolbar.className = 'lms-terminal-copy-toolbar';

    const copySelectionButton = document.createElement('button');
    copySelectionButton.type = 'button';
    copySelectionButton.textContent = '复制选中内容';
    copySelectionButton.addEventListener('click', () => {
      const selection = String(window.getSelection ? window.getSelection() : '').trim();
      copyText(selection || collectReportText());
    });

    const copyReportButton = document.createElement('button');
    copyReportButton.type = 'button';
    copyReportButton.textContent = '复制并打开剪贴板';
    copyReportButton.addEventListener('click', () => {
      copyText(collectReportText());
    });

    const sendToTerminalButton = document.createElement('button');
    sendToTerminalButton.type = 'button';
    sendToTerminalButton.textContent = '写入平台剪贴板';
    sendToTerminalButton.title = '写入平台「剪贴板」弹窗后，到虚拟机终端右键 Paste 或按 Ctrl+Shift+V';
    sendToTerminalButton.addEventListener('click', async () => {
      const selection = String(window.getSelection ? window.getSelection() : '').trim();
      const value = normalizeForTerminal(selection || collectReportText());
      if (!value) {
        showToast('没有可发送的内容');
        return;
      }
      const clipboardOk = await copyToBrowserClipboard(value);
      const ok = await pasteIntoLabPlatformClipboard(value);
      showToast(ok
        ? `已写入剪贴板 ${value.length} 字符，在终端 Ctrl+Shift+V 粘贴`
        : clipboardOk
          ? `已复制 ${value.length} 字符，在终端 Ctrl+Shift+V 粘贴`
          : '复制失败，请检查脚本猫剪贴板权限');
    });

    toolbar.appendChild(copySelectionButton);
    toolbar.appendChild(copyReportButton);
    toolbar.appendChild(sendToTerminalButton);
    document.body.appendChild(toolbar);
  }

  function enhancePage() {
    injectStyle();
    createToolbar();
    document.querySelectorAll(SELECTORS.copyTargets).forEach(enhanceBlock);
  }

  function observePageChanges() {
    const observer = new MutationObserver(() => {
      window.clearTimeout(observePageChanges.timer);
      observePageChanges.timer = window.setTimeout(enhancePage, 250);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  ready(() => {
    enhancePage();
    observePageChanges();
  });
})();
