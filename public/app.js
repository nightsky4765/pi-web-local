import { initEffects } from "./effects.js";

initEffects();

const $ = (selector) => document.querySelector(selector);
const messages = $("#messages");
const prompt = $("#prompt");
const sendButton = $("#send");
const stopButton = $("#stop");
const attachmentsView = $("#attachments");
const allowedTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
let attachments = [];
let availableModels = [];
let currentModelKey = "";
let pendingInterjection = null;
let nextMessageTag = "";
let busy = false;

await initialize();

async function initialize() {
  try {
    const [status, history] = await Promise.all([api("/api/status"), api("/api/history")]);
    updateStatus(status);
    if (history.length) {
      $("#welcome")?.remove();
      for (const item of history) addMessage(item.role, item.text, item.images || 0);
      scrollDown();
    }
    $("#connection").textContent = "已連線 · 僅限本機";
    prompt.focus({ preventScroll: true });
  } catch (error) {
    $("#connection").textContent = "連線失敗";
    addMessage("assistant", `無法連接後端：${error.message}`);
  }
}

$("#attach").addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", (event) => addFiles(event.target.files));
$("#new-chat").addEventListener("click", newChat);
$("#thinking").addEventListener("click", (event) => {
  event.stopPropagation();
  const menu = $("#thinking-menu");
  menu.hidden = !menu.hidden;
  $("#thinking").setAttribute("aria-expanded", String(!menu.hidden));
});
$("#thinking-menu").addEventListener("click", (event) => {
  const option = event.target.closest("[data-level]");
  if (option) changeThinking(option.dataset.level);
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".thinking-control")) closeThinkingMenu();
});
sendButton.addEventListener("click", send);
stopButton.addEventListener("click", stop);
$("#model").addEventListener("click", openModelPicker);
$("#model-search").addEventListener("input", renderModelList);
messages.addEventListener("click", (event) => {
  const suggestion = event.target.closest("[data-prompt]");
  if (!suggestion || busy) return;
  prompt.value = suggestion.dataset.prompt;
  resizePrompt();
  prompt.focus();
});

prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    send();
  } else if (event.key === "Escape" && busy) stop();
});
prompt.addEventListener("input", resizePrompt);

document.addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith("image/"));
  if (files.length) {
    event.preventDefault();
    addFiles(files);
  }
});

const dropZone = $("#drop-zone");
for (const eventName of ["dragenter", "dragover"]) dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.add("dragging"); });
for (const eventName of ["dragleave", "drop"]) dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.remove("dragging"); });
dropZone.addEventListener("drop", (event) => addFiles(event.dataTransfer.files));

async function addFiles(fileList) {
  for (const file of fileList) {
    if (attachments.length >= 5) return notify("一次最多附加 5 張圖片");
    if (!allowedTypes.has(file.type)) { notify(`不支援 ${file.name} 的格式`); continue; }
    if (file.size > 8 * 1024 * 1024) { notify(`${file.name} 超過 8 MB`); continue; }
    attachments.push({ file, url: URL.createObjectURL(file) });
  }
  renderAttachments();
  $("#file-input").value = "";
}

function renderAttachments() {
  attachmentsView.replaceChildren();
  attachments.forEach((item, index) => {
    const box = document.createElement("div");
    box.className = "attachment";
    const image = document.createElement("img");
    image.src = item.url;
    image.alt = item.file.name;
    const remove = document.createElement("button");
    remove.textContent = "×";
    remove.title = "移除";
    remove.addEventListener("click", () => {
      URL.revokeObjectURL(item.url);
      attachments.splice(index, 1);
      renderAttachments();
    });
    box.append(image, remove);
    attachmentsView.append(box);
  });
}

async function send() {
  const text = prompt.value.trim();
  if (busy) return steerCurrentReply(text);
  if (!text && !attachments.length) return;
  const files = [...attachments];
  addMessage("user", text, files.length, nextMessageTag);
  nextMessageTag = "";
  prompt.value = "";
  resizePrompt();
  clearAttachments();
  setBusy(true);

  let assistant = addMessage("assistant", "");
  let bubble = assistant.querySelector(".bubble");
  let fullText = "";
  let fullThinking = "";
  let thinkingView;
  let assistantTurns = 0;
  const tools = new Map();

  try {
    const images = await Promise.all(files.map(async ({ file }) => ({ mediaType: file.type, name: file.name, data: await fileBase64(file) })));
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, images }),
    });
    if (!response.ok) throw new Error(await responseError(response));
    if (!response.body) throw new Error("瀏覽器不支援串流回應");

    for await (const event of readNdjson(response.body)) {
      if (event.type === "assistant-start") {
        assistantTurns += 1;
        if (assistantTurns > 1) {
          assistant = addMessage("assistant", "");
          bubble = assistant.querySelector(".bubble");
          fullText = "";
          fullThinking = "";
          thinkingView = undefined;
        }
      } else if (event.type === "text") {
        fullText += event.delta;
        bubble.innerHTML = renderMarkdown(fullText);
      } else if (event.type === "thinking") {
        fullThinking += event.delta;
        if (!thinkingView) {
          thinkingView = document.createElement("details");
          thinkingView.className = "thinking";
          thinkingView.innerHTML = "<summary>思考過程</summary><div></div>";
          assistant.insertBefore(thinkingView, bubble);
        }
        thinkingView.querySelector("div").textContent = fullThinking;
      } else if (event.type === "tool-start") {
        const tool = document.createElement("span");
        tool.className = "tool-card";
        tool.textContent = `◌ ${event.name} 執行中`;
        tool.title = truncate(JSON.stringify(event.args), 1000);
        bubble.before(tool);
        tools.set(event.id, tool);
      } else if (event.type === "tool-end") {
        const tool = tools.get(event.id);
        if (tool) { tool.classList.add(event.error ? "error" : "ok"); tool.textContent = `${event.error ? "×" : "✓"} ${event.name}`; }
      } else if (event.type === "error") throw new Error(event.message);
      scrollDown();
    }
    if (!fullText && !bubble.childNodes.length) bubble.textContent = "（沒有文字回覆）";
  } catch (error) {
    bubble.textContent = `錯誤：${error.message}`;
    bubble.style.color = "#e9a0a5";
  } finally {
    files.forEach((item) => URL.revokeObjectURL(item.url));
    setBusy(false);
    const interjection = pendingInterjection;
    pendingInterjection = null;
    if (interjection) {
      interjection.message.remove();
      prompt.value = interjection.text;
      nextMessageTag = "插嘴";
      await send();
    } else {
      prompt.focus({ preventScroll: true });
      refreshStatus();
    }
  }
}

async function steerCurrentReply(text) {
  if (!text || pendingInterjection) return;
  if (attachments.length) return notify("插嘴目前只支援文字；請先移除圖片或停止回覆後再傳送。");
  prompt.value = "";
  resizePrompt();
  const message = addMessage("user", text, 0, "插嘴");
  message.classList.add("interjection");
  pendingInterjection = { text, message };
  sendButton.disabled = true;
  try {
    await api("/api/abort", { method: "POST" });
  } catch (error) {
    pendingInterjection = null;
    message.querySelector(".role").textContent = "你 · 插嘴失敗";
    notify(error.message);
  } finally {
    sendButton.disabled = false;
    prompt.focus({ preventScroll: true });
  }
}

async function stop() {
  if (!busy) return;
  stopButton.disabled = true;
  try { await api("/api/abort", { method: "POST" }); }
  catch (error) { notify(error.message); }
  finally { stopButton.disabled = false; }
}

async function newChat() {
  if (busy) return notify("請先停止目前的回覆");
  if (!confirm("建立新對話？目前對話仍會保存在 Pi Session 中。")) return;
  try {
    const status = await api("/api/session/new", { method: "POST" });
    messages.replaceChildren(createWelcome());
    updateStatus(status);
    prompt.focus();
  } catch (error) { notify(error.message); }
}

async function changeThinking(level) {
  closeThinkingMenu();
  try {
    const status = await api("/api/thinking", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ level }) });
    updateStatus(status);
  } catch (error) { notify(error.message); refreshStatus(); }
}

function closeThinkingMenu() {
  $("#thinking-menu").hidden = true;
  $("#thinking").setAttribute("aria-expanded", "false");
}

function addMessage(role, text, imageCount = 0, tag = "") {
  $("#welcome")?.remove();
  const section = document.createElement("section");
  section.className = `message ${role}`;
  if (tag === "插嘴") section.classList.add("interjection");
  const label = document.createElement("div");
  label.className = "role";
  label.textContent = `${role === "user" ? "你" : role === "assistant" ? "Pi" : "工具"}${tag ? ` · ${tag}` : ""}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = renderMarkdown(text || "");
  if (imageCount) {
    const badge = document.createElement("span");
    badge.className = "image-count";
    badge.textContent = `▧ ${imageCount} 張圖片`;
    bubble.prepend(badge);
  }
  section.append(label, bubble);
  messages.append(section);
  scrollDown();
  return section;
}

function renderMarkdown(source) {
  const escaped = escapeHtml(source);
  const blocks = [];
  let html = escaped.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const index = blocks.length;
    blocks.push(`<pre><code data-lang="${escapeHtml(lang.trim())}">${code}</code></pre>`);
    return `\u0000BLOCK${index}\u0000`;
  });
  html = html
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/^### (.+)$/gm, "<strong>$1</strong>")
    .replace(/^## (.+)$/gm, "<strong>$1</strong>")
    .replace(/^# (.+)$/gm, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
  return html.replace(/\u0000BLOCK(\d+)\u0000/g, (_, index) => blocks[Number(index)]);
}

async function* readNdjson(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) if (line.trim()) yield JSON.parse(line);
    if (done) break;
  }
  if (buffer.trim()) yield JSON.parse(buffer);
}

async function openModelPicker() {
  if (busy) return;
  const dialog = $("#model-dialog");
  dialog.showModal();
  $("#model-search").value = "";
  $("#model-search").focus();
  if (!availableModels.length) {
    $("#model-list").innerHTML = '<p class="loading-models">正在讀取可用模型…</p>';
    try {
      availableModels = await api("/api/models");
      renderModelList();
    } catch (error) {
      $("#model-list").textContent = `無法取得模型：${error.message}`;
    }
  } else renderModelList();
}

function renderModelList() {
  const query = $("#model-search").value.trim().toLowerCase();
  const filtered = availableModels.filter((model) => `${model.provider} ${model.id} ${model.name}`.toLowerCase().includes(query));
  const list = $("#model-list");
  list.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "loading-models";
    empty.textContent = "找不到符合的模型";
    list.append(empty);
    return;
  }
  let provider = "";
  for (const model of filtered) {
    if (model.provider !== provider) {
      provider = model.provider;
      const heading = document.createElement("h3");
      heading.textContent = provider;
      list.append(heading);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "model-option";
    const key = `${model.provider}/${model.id}`;
    if (key === currentModelKey) button.classList.add("selected");
    const name = document.createElement("span");
    name.innerHTML = `<strong>${escapeHtml(model.name || model.id)}</strong><small>${escapeHtml(model.id)}</small>`;
    const meta = document.createElement("span");
    meta.className = "model-meta";
    meta.textContent = `${model.supportsImages ? "圖片 · " : ""}${model.reasoning ? "推理 · " : ""}${formatTokens(model.contextWindow)}`;
    button.append(name, meta);
    button.addEventListener("click", () => chooseModel(model, button));
    list.append(button);
  }
}

async function chooseModel(model, button) {
  button.disabled = true;
  try {
    const status = await api("/api/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: model.provider, id: model.id }),
    });
    updateStatus(status);
    $("#model-dialog").close();
  } catch (error) {
    notify(`切換模型失敗：${error.message}`);
  } finally { button.disabled = false; }
}

function updateStatus(status) {
  const label = $("#model span");
  label.textContent = status.model ? `${status.model.provider} / ${status.model.id}${status.model.supportsImages ? " · 圖片" : ""}` : "沒有可用模型";
  currentModelKey = status.model ? `${status.model.provider}/${status.model.id}` : "";
  $("#thinking span").textContent = status.thinkingLevel;
  document.querySelectorAll("#thinking-menu [data-level]").forEach((option) => option.classList.toggle("selected", option.dataset.level === status.thinkingLevel));
  $("#workspace").textContent = status.workspace;
  $("#workspace").title = status.workspace;
}
async function refreshStatus() { try { updateStatus(await api("/api/status")); } catch {} }
function setBusy(value) {
  busy = value;
  dropZone.classList.toggle("busy", value);
  stopButton.hidden = !value;
  sendButton.innerHTML = value ? '插嘴 <span>↪</span>' : '送出 <span>↑</span>';
  sendButton.title = value ? "插入指示，讓 Pi 在目前工具完成後調整方向" : "送出訊息";
  prompt.placeholder = value ? "想改變方向？直接插嘴…" : "傳訊息給 Pi…（Enter 傳送，Shift+Enter 換行）";
  $("#new-chat").disabled = value;
  $("#model").disabled = value;
  $("#thinking").disabled = value;
  if (value) closeThinkingMenu();
}
function clearAttachments() { attachments = []; attachmentsView.replaceChildren(); }
function resizePrompt() { prompt.style.height = "auto"; prompt.style.height = `${Math.min(prompt.scrollHeight, 180)}px`; }
function scrollDown() { requestAnimationFrame(() => messages.scrollTop = messages.scrollHeight); }
function notify(text) { addMessage("assistant", text); }
function fileBase64(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = () => reject(new Error(`無法讀取 ${file.name}`)); reader.readAsDataURL(file); }); }
async function api(url, options) { const response = await fetch(url, options); if (!response.ok) throw new Error(await responseError(response)); return response.json(); }
async function responseError(response) { try { return (await response.json()).error || `HTTP ${response.status}`; } catch { return `HTTP ${response.status}`; } }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
function truncate(value, max) { return value.length > max ? `${value.slice(0, max)}…` : value; }
function formatTokens(value) { return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : `${Math.round(value / 1000)}K`; }
function createWelcome() {
  const section = document.createElement("section");
  section.id = "welcome";
  section.className = "welcome";
  section.innerHTML = `
    <div class="welcome-mark"><div class="orb orb-one"></div><div class="orb orb-two"></div><div class="logo large">π</div></div>
    <p class="eyebrow">A FRESH CONVERSATION</p>
    <h1>新的對話，新的可能</h1>
    <p class="welcome-copy">從一個問題、一張圖片，或一段程式碼開始。</p>
    <div class="suggestions">
      <button data-prompt="幫我快速了解目前專案的結構與用途。"><b>⌘</b><span>了解專案<small>快速整理結構與用途</small></span></button>
      <button data-prompt="請檢查目前專案，找出可能的問題並提出改善建議。"><b>◇</b><span>檢查問題<small>找出風險與改善方向</small></span></button>
      <button data-prompt="我會貼上一張圖片，請仔細分析圖片內容。"><b>▧</b><span>分析圖片<small>貼上截圖或設計稿</small></span></button>
    </div>`;
  return section;
}
