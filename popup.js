/* global chrome */

const ROOT_FOLDER_NAME = "V2EX 备份收藏";
const TOPICS_URL = "https://www.v2ex.com/my/topics";
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;

const syncButton = document.querySelector("#syncButton");
const statusText = document.querySelector("#statusText");
const detailText = document.querySelector("#detailText");
const progressBar = document.querySelector("#progressBar");
const statusIcon = document.querySelector("#statusIcon");

syncButton.addEventListener("click", syncBookmarks);

function setStatus(state, title, detail, progress = null) {
  statusText.textContent = title;
  detailText.textContent = detail;
  statusIcon.className = `status-icon ${state}`;
  if (progress !== null) progressBar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function randomDelay() {
  return 1000 + Math.floor(Math.random() * 1001);
}

function isRetryableStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504 || status >= 500;
}

async function fetchPage(page) {
  const url = page === 1 ? TOPICS_URL : `${TOPICS_URL}?p=${page}`;
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      // credentials: include 会让请求自动携带当前浏览器中的 V2EX Cookie。
      const response = await fetch(url, {
        credentials: "include",
        signal: controller.signal,
        cache: "no-store"
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const error = new Error(`服务器返回 HTTP ${response.status}`);
        error.retryable = isRetryableStatus(response.status);
        throw error;
      }
      return { html: await response.text(), finalUrl: response.url };
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      const retryable = error.name === "AbortError" || error.retryable || error instanceof TypeError;
      if (!retryable || attempt === MAX_RETRIES) break;
      await sleep(800 * attempt + Math.floor(Math.random() * 500));
    }
  }

  throw lastError || new Error("请求失败");
}

function parseDocument(html) {
  return new DOMParser().parseFromString(html, "text/html");
}

function ensureExpectedPage(documentNode) {
  // 登录页和 WAF/异常页通常不含 V2EX 主内容容器，避免将错误页面当作空收藏。
  if (!documentNode.querySelector("#Main, #Wrapper")) {
    throw new Error("页面结构无法识别，V2EX 可能返回了异常页面或页面已改版。请稍后重试。");
  }
}

function ensureSignedIn(documentNode, finalUrl) {
  const path = new URL(finalUrl).pathname;
  const loginLink = documentNode.querySelector('a[href="/signin"], a[href^="/signin?"]');
  const signInForm = documentNode.querySelector('form[action="/signin"], input[name="username"]');

  if (path.startsWith("/signin") || signInForm || loginLink) {
    throw new Error("未检测到 V2EX 登录状态。请先在当前浏览器登录 V2EX 后重试。");
  }
}

function getTotalPages(documentNode) {
  // 不能直接读取 .page_normal：页面其他区域也可能使用这个类或显示数字。
  const pageNumbers = [...documentNode.querySelectorAll("a[href]")]
    .map((link) => new URL(link.getAttribute("href"), TOPICS_URL))
    .filter((url) => url.pathname === "/my/topics" && url.searchParams.has("p"))
    .map((url) => Number(url.searchParams.get("p")))
    .filter((number) => Number.isInteger(number) && number > 0);
  return Math.max(1, ...pageNumbers);
}

function extractTopics(documentNode) {
  const main = documentNode.querySelector("#Main");
  if (!main) return [];

  // 优先取已知标题容器；新版主题页改动类名时，再在主内容区内回退匹配。
  let links = main.querySelectorAll('.item_title a[href], .topic-title a[href], a.topic-link[href]');
  if (links.length === 0) {
    links = main.querySelectorAll('a[href^="/t/"], a[href*=".v2ex.com/t/"]');
  }
  const topics = new Map();

  for (const link of links) {
    const url = new URL(link.getAttribute("href"), TOPICS_URL);
    if (!/\.v2ex\.com$/i.test(url.hostname) || !/^\/t\/\d+/.test(url.pathname)) continue;
    url.hash = "";
    const title = link.textContent.replace(/\s+/g, " ").trim();
    if (title) topics.set(url.href, { title, url: url.href });
  }

  return [...topics.values()];
}

async function getOrCreateRootFolder() {
  const matches = await chrome.bookmarks.search({ title: ROOT_FOLDER_NAME });
  const folder = matches.find((node) => !node.url);
  if (folder) return folder;
  // "1" 是 Chrome 的书签栏根节点，固定文件夹直接创建在这里。
  return chrome.bookmarks.create({ parentId: "1", title: ROOT_FOLDER_NAME });
}

async function getExistingUrls(folderId) {
  const children = await chrome.bookmarks.getChildren(folderId);
  const urls = new Set();
  for (const child of children) {
    if (!child.url) continue;
    const url = new URL(child.url);
    url.hash = "";
    urls.add(url.href);
  }
  return urls;
}

async function syncBookmarks() {
  syncButton.disabled = true;
  progressBar.style.width = "0%";
  let currentPage = 0;
  let addedCount = 0;

  try {
    setStatus("running", "检查登录状态...", "正在读取你的 V2EX 收藏页面。", 4);
    const firstResponse = await fetchPage(1);
    const firstDocument = parseDocument(firstResponse.html);
    ensureExpectedPage(firstDocument);
    ensureSignedIn(firstDocument, firstResponse.finalUrl);

    const totalPages = getTotalPages(firstDocument);
    const allTopics = new Map(extractTopics(firstDocument).map((topic) => [topic.url, topic]));
    currentPage = 1;

    for (let page = 2; page <= totalPages; page += 1) {
      setStatus("running", `正在抓取第 ${page}/${totalPages} 页...`, "为避免触发限流，正在按顺序低速请求。", ((page - 1) / totalPages) * 70);
      await sleep(randomDelay());
      const response = await fetchPage(page);
      const documentNode = parseDocument(response.html);
      ensureExpectedPage(documentNode);
      ensureSignedIn(documentNode, response.finalUrl);
      const topics = extractTopics(documentNode);
      if (topics.length === 0) throw new Error("页面结构无法识别，未找到收藏帖子链接。请稍后重试或检查 V2EX 页面是否改版。");
      topics.forEach((topic) => allTopics.set(topic.url, topic));
      currentPage = page;
    }

    setStatus("running", "正在比对已有书签...", `已抓取 ${allTopics.size} 条收藏。`, 75);
    const folder = await getOrCreateRootFolder();
    const existingUrls = await getExistingUrls(folder.id);
    const newTopics = [...allTopics.values()].filter((topic) => !existingUrls.has(topic.url));

    if (newTopics.length > 0) {
      setStatus("running", `发现 ${newTopics.length} 条新收藏...`, "正在写入 Chrome 书签。", 84);
      for (let index = 0; index < newTopics.length; index += 1) {
        const topic = newTopics[index];
        await chrome.bookmarks.create({ parentId: folder.id, title: topic.title, url: topic.url });
        addedCount += 1;
        progressBar.style.width = `${84 + ((index + 1) / newTopics.length) * 16}%`;
      }
    }

    setStatus("success", "同步完成", `共抓取 ${allTopics.size} 条收藏，本次新增 ${addedCount} 条书签。`, 100);
  } catch (error) {
    const message = error?.message || "发生未知错误";
    const pageHint = currentPage > 0 ? `已同步 ${addedCount} 条，第 ${currentPage + 1} 页失败。` : "同步尚未开始写入书签。";
    setStatus("error", "同步失败", `${pageHint} ${message}`, 0);
  } finally {
    syncButton.disabled = false;
  }
}
