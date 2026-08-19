// ═══════════════════════════════════════════
// STATE MANAGEMENT & PERFORMANCE CONSTANTS
// ═══════════════════════════════════════════
const MAX_DOM_LINES = 2000;       // Max DOM nodes to keep UI at 60 FPS
const MAX_STORED_LINES = 10000;   // Max in-memory lines retained in ring buffer
const BATCH_FLUSH_INTERVAL = 50;  // Flush incoming logs to DOM every 50ms

let logsPassword = localStorage.getItem('logs_password') || '';
let activeFile = '';
let originalLogLines = [];        // Ring buffer of log lines
let filesList = [];
let ws = null;
let reconnectTimeout = null;
let reconnectAttempts = 0;
let filterTab = 'all';
let debounceTimer = null;
let statsDebounceTimer = null;

// Streaming & Auto-scroll States
let isStreamPaused = false;
let isAutoScrollEnabled = true;
let unreadPausedCount = 0;
let incomingBatch = [];
let batchRafId = null;

// Real-time Throughput (RPS) Tracker
let rpsWindow = [];
let rpsInterval = null;

// Running Cumulative Statistics
let stats = {
    totalRequests: 0,
    l1Hits: 0,
    l2Hits: 0,
    cacheMisses: 0,
    errors: 0,
    latencySum: 0,
    latencyCount: 0,
    uniqueIps15m: new Set(),
    uniqueIpsDaily: new Set()
};

// ═══════════════════════════════════════════
// INITIALIZATION & EVENT LISTENERS
// ═══════════════════════════════════════════
if (logsPassword) {
    testAuthAndInitialize();
}

// Start Throughput Meter Interval (updates RPS display every second)
rpsInterval = setInterval(updateRpsMeter, 1000);

// Global Keyboard Shortcuts
document.addEventListener('keydown', (e) => {
    // If typing in search or password, ignore space shortcut
    const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
    const isInputActive = activeTag === 'input' || activeTag === 'textarea';

    // Space = Toggle Stream Pause/Resume
    if (e.code === 'Space' && !isInputActive && activeFile) {
        e.preventDefault();
        toggleStreamPause();
    }
    // Ctrl+L or Cmd+L = Clear Console View
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        clearConsole();
    }
    // Ctrl+K or Cmd+K = Focus Search Bar
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const searchInput = document.getElementById('search-filter');
        if (searchInput) searchInput.focus();
    }
    // Escape = Close Modals & Sidebar
    if (e.key === 'Escape') {
        closeSidebar();
        closeBannedModal();
        clearSearch();
    }
});

// Track scroll position for smart auto-scroll & floating FAB
document.addEventListener('DOMContentLoaded', () => {
    const consoleEl = document.getElementById('console-scroll');
    if (consoleEl) {
        consoleEl.addEventListener('scroll', handleUserScroll, { passive: true });
    }
});

// ═══════════════════════════════════════════
// AUTHENTICATION
// ═══════════════════════════════════════════
async function handleLogin(e) {
    e.preventDefault();
    const passwordInput = document.getElementById('password').value;
    const errorMsg = document.getElementById('error-msg');
    const loginBtn = document.getElementById('login-btn');

    errorMsg.style.display = 'none';
    loginBtn.disabled = true;
    loginBtn.innerHTML = '<div class="loading-spinner" style="width:16px;height:16px;border-width:2px;"></div> Authenticating...';

    logsPassword = passwordInput;

    try {
        const success = await loadFileList(passwordInput);
        if (success) {
            localStorage.setItem('logs_password', logsPassword);
            document.getElementById('login-card').style.display = 'none';
            const dashboard = document.getElementById('dashboard');
            dashboard.style.display = 'grid';
            void dashboard.offsetWidth; // Trigger reflow
            showToast("Authenticated successfully");
        } else {
            errorMsg.style.display = 'block';
            document.getElementById('password').value = '';
            logsPassword = '';
        }
    } catch (err) {
        errorMsg.style.display = 'block';
        logsPassword = '';
    }

    loginBtn.disabled = false;
    loginBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/></svg> Authenticate';
}

async function testAuthAndInitialize() {
    const success = await loadFileList(logsPassword);
    if (success) {
        document.getElementById('login-card').style.display = 'none';
        document.getElementById('dashboard').style.display = 'grid';
    } else {
        localStorage.removeItem('logs_password');
        logsPassword = '';
    }
}

function logout() {
    localStorage.removeItem('logs_password');
    logsPassword = '';
    if (ws) ws.close();
    location.reload();
}

// ═══════════════════════════════════════════
// SIDEBAR & FILE MANAGEMENT
// ═══════════════════════════════════════════
function openSidebar() {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('backdrop').style.display = 'block';
}

function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('backdrop').style.display = 'none';
}

async function loadFileList(pwd) {
    try {
        const response = await fetch('/api/logs/files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pwd })
        });

        if (!response.ok) return false;

        const result = await response.json();
        if (!result.success) return false;

        const files = result.data || [];
        filesList = files;
        const listContainer = document.getElementById('file-list');
        listContainer.innerHTML = '';

        if (files.length === 0) {
            listContainer.innerHTML = '<div style="color: var(--text-dim); font-size: 0.8rem; padding: 0.75rem; text-align: center;">No log files found</div>';
            return true;
        }

        files.forEach((file, index) => {
            const item = document.createElement('div');
            item.className = 'file-item';
            item.innerHTML = `
                <svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(file)}</span>
            `;
            item.onclick = () => {
                selectFile(file, item);
                closeSidebar();
            };
            listContainer.appendChild(item);

            // Auto-select the first (latest) log file
            if (index === 0 && !activeFile) {
                selectFile(file, item);
            } else if (file === activeFile) {
                item.classList.add('active');
            }
        });

        return true;
    } catch (err) {
        console.error("Error loading file list:", err);
        return false;
    }
}

function selectFile(filename, element) {
    document.querySelectorAll('.file-item').forEach(el => el.classList.remove('active'));

    activeFile = filename;
    reconnectAttempts = 0;
    unreadPausedCount = 0;
    updatePausedBadge();

    if (element) element.classList.add('active');
    document.getElementById('active-filename').innerText = filename;

    // Reset ring buffer and clear UI
    originalLogLines = [];
    resetStats();
    showLoadingState();

    // Connect WebSocket
    connectLogsWs();
}

// ═══════════════════════════════════════════
// WEBSOCKET INGESTION & BATCH DISPATCHER
// ═══════════════════════════════════════════
function updateConnectionStatus(status) {
    const badge = document.getElementById('connection-status');
    const text = document.getElementById('status-text');

    switch (status) {
        case 'live':
            badge.className = 'status-badge live';
            text.innerText = 'Live Stream';
            break;
        case 'history':
            badge.className = 'status-badge';
            text.innerText = 'Historical';
            break;
        case 'connecting':
            badge.className = 'status-badge connecting';
            text.innerText = 'Connecting';
            break;
        case 'reconnecting':
            badge.className = 'status-badge connecting';
            text.innerText = 'Reconnecting';
            break;
        case 'error':
            badge.className = 'status-badge error';
            text.innerText = 'Error';
            break;
        default:
            badge.className = 'status-badge disconnected';
            text.innerText = 'Disconnected';
    }
}

function connectLogsWs() {
    if (!activeFile) return;

    if (ws) {
        ws.close();
        ws = null;
    }
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }

    updateConnectionStatus('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/logs/ws?password=${encodeURIComponent(logsPassword)}&file_name=${encodeURIComponent(activeFile)}`;

    try {
        ws = new WebSocket(wsUrl);
    } catch (err) {
        console.error("WebSocket creation failed:", err);
        updateConnectionStatus('disconnected');
        showErrorState("Failed to connect to WebSocket");
        return;
    }

    ws.onopen = () => {
        reconnectAttempts = 0;
        if (filesList && filesList.length > 0 && activeFile === filesList[0]) {
            updateConnectionStatus('live');
        } else {
            updateConnectionStatus('history');
        }
    };

    ws.onmessage = (event) => {
        const message = event.data;

        if (message.startsWith('[INITIAL_DUMP]\n')) {
            // Initial dump from tail reader
            const content = message.slice(15);
            const lines = content.split('\n').filter(line => line.trim() !== '');
            originalLogLines = lines.slice(-MAX_STORED_LINES);
            applyAllFilters();

            if (originalLogLines.length === 0) {
                showEmptyLogState();
            }
        } else if (message.startsWith('[SYS_STATUS]')) {
            // Telemetry & system status message
            try {
                const sys = JSON.parse(message.slice(12));
                document.getElementById('stat-cache-sys').innerText = sys.cache_system || 'Operational';
                document.getElementById('stat-redis-sys').innerText = sys.redis || 'Operational';
                if (sys.banned_ips !== undefined) {
                    document.getElementById('stat-banned-ips').innerText = sys.banned_ips;
                }
            } catch (e) {
                console.error("Failed to parse system status", e);
            }
        } else {
            // Live streamed log line
            handleIncomingLogMessage(message);
        }
    };

    ws.onclose = (event) => {
        const reason = event.reason || '';
        if (event.code === 4001 || reason.includes('Unauthorized')) {
            logout();
            return;
        }

        // Reconnect automatically for today's live file
        if (filesList && filesList.length > 0 && activeFile === filesList[0]) {
            reconnectAttempts++;
            if (reconnectAttempts <= 10) {
                updateConnectionStatus('reconnecting');
                const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 30000);
                reconnectTimeout = setTimeout(() => {
                    connectLogsWs();
                }, delay);
            } else {
                updateConnectionStatus('error');
                showErrorState('Connection lost after 10 attempts. Click a log file to retry.');
            }
        } else {
            updateConnectionStatus('disconnected');
        }
    };

    ws.onerror = (error) => {
        console.error("WebSocket error:", error);
    };
}

/**
 * Handle incoming log messages with high-frequency batching and RAF
 */
function handleIncomingLogMessage(rawMessage) {
    // Record for live throughput calculation
    rpsWindow.push(Date.now());

    // Ingest into ring buffer
    originalLogLines.push(rawMessage);
    if (originalLogLines.length > MAX_STORED_LINES) {
        originalLogLines.shift();
    }

    // Process statistics incrementally
    ingestLineStats(rawMessage);
    scheduleStatsUpdate();

    // If stream is paused, increment unread counter and skip DOM write
    if (isStreamPaused) {
        unreadPausedCount++;
        updatePausedBadge();
        updateScrollFab();
        return;
    }

    // Queue for batch DOM flush
    incomingBatch.push(rawMessage);
    scheduleBatchFlush();
}

function scheduleBatchFlush() {
    if (!batchRafId) {
        batchRafId = requestAnimationFrame(() => {
            flushBatchToDom();
            batchRafId = null;
        });
    }
}

function flushBatchToDom() {
    if (incomingBatch.length === 0) return;

    const outputContainer = document.getElementById('log-output');
    if (!outputContainer) return;

    // Clear empty/loading/error states if present
    const emptyState = document.getElementById('empty-state');
    const loadingState = document.getElementById('loading-state');
    const errorState = document.getElementById('error-state');
    if (emptyState) emptyState.remove();
    if (loadingState) loadingState.remove();
    if (errorState) errorState.remove();

    const wasAtBottom = checkIsScrollAtBottom();
    const fragment = document.createDocumentFragment();

    const batch = incomingBatch;
    incomingBatch = [];

    for (let i = 0; i < batch.length; i++) {
        const msg = batch[i];
        if (linePassesFilters(msg)) {
            const div = document.createElement('div');
            div.innerHTML = formatLogLine(msg);
            const node = div.firstChild;
            if (node) {
                attachLogLineEvents(node, msg);
                fragment.appendChild(node);
            }
        }
    }

    outputContainer.appendChild(fragment);

    // Prune oldest DOM nodes to maintain MAX_DOM_LINES window
    pruneDomNodes(outputContainer);

    if (isAutoScrollEnabled && wasAtBottom) {
        scrollToBottom();
    } else {
        updateScrollFab();
    }
}

function pruneDomNodes(container) {
    const excess = container.children.length - MAX_DOM_LINES;
    if (excess > 0) {
        for (let i = 0; i < excess; i++) {
            if (container.firstChild) {
                container.removeChild(container.firstChild);
            }
        }
    }
}

// ═══════════════════════════════════════════
// LOG PARSING & RICH HIGHLIGHTING
// ═══════════════════════════════════════════
function parseLogLine(line) {
    if (line.includes('[L1 CACHE HIT]')) return { type: 'l1-cache-hit', raw: line };
    if (line.includes('[L2 CACHE HIT]')) return { type: 'l2-cache-hit', raw: line };
    if (line.includes('[CACHE HIT]')) return { type: 'l2-cache-hit', raw: line };
    if (line.includes('[CACHE MISS]')) return { type: 'cache-miss', raw: line };
    if (line.includes('[CACHE EXPIRED]')) return { type: 'cache-expired', raw: line };
    if (line.includes('[UPSTREAM FETCH SUCCESS]')) return { type: 'upstream', raw: line };
    if (line.includes('[DDOS PROTECT]')) return { type: 'ddos-protect', raw: line };
    if (line.includes('[CIRCUIT BREAKER]')) return { type: 'circuit-breaker', raw: line };

    // Extract Timestamp if present: [YYYY-MM-DD HH:MM:SS]
    let time = '';
    let rest = line.trim();
    const timeMatch = rest.match(/^(\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\])\s*/);
    if (timeMatch) {
        time = timeMatch[1];
        rest = rest.slice(timeMatch[0].length);
    }

    // Extract IP if present: [IP: xxx]
    let ip = 'unknown';
    const ipMatch = rest.match(/^\[IP:\s*([^\]]+)\]\s*/);
    if (ipMatch) {
        ip = ipMatch[1].trim();
        rest = rest.slice(ipMatch[0].length);
    }

    // Extract User-Agent if present: [UA: xxx]
    let ua = 'unknown';
    const uaMatch = rest.match(/^\[UA:\s*(.*?)\]\s+(?=(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s)/i);
    if (uaMatch) {
        ua = uaMatch[1].trim();
        rest = rest.slice(uaMatch[0].length);
    } else {
        const simpleUaMatch = rest.match(/^\[UA:\s*([^\]]+)\]\s*/);
        if (simpleUaMatch) {
            ua = simpleUaMatch[1].trim();
            rest = rest.slice(simpleUaMatch[0].length);
        }
    }

    // Match HTTP Request: METHOD URI STATUS DURATION [SIZE]
    const reqMatch = rest.match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\S+)\s+(\d{3})\s+(\d+)ms(?:\s+(\d+)B)?/i);
    if (reqMatch) {
        return {
            type: 'request',
            raw: line,
            time: time || '[Live]',
            ip: ip,
            ua: ua,
            method: reqMatch[1].toUpperCase(),
            uri: reqMatch[2],
            status: parseInt(reqMatch[3], 10),
            statusStr: reqMatch[3],
            duration: `${reqMatch[4]}ms`,
            durationMs: parseInt(reqMatch[4], 10),
            sizeBytes: reqMatch[5] || '0'
        };
    }

    // Loose match fallback for any custom or legacy formatted request
    const looseMatch = rest.match(/\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\S+)\s+(\d{3})(?:\s+(\d+)ms)?/i);
    if (looseMatch) {
        const durMs = looseMatch[4] ? parseInt(looseMatch[4], 10) : 0;
        return {
            type: 'request',
            raw: line,
            time: time || '[Live]',
            ip: ip,
            ua: ua,
            method: looseMatch[1].toUpperCase(),
            uri: looseMatch[2],
            status: parseInt(looseMatch[3], 10),
            statusStr: looseMatch[3],
            duration: durMs ? `${durMs}ms` : '',
            durationMs: durMs,
            sizeBytes: '0'
        };
    }

    return { type: 'unknown', raw: line };
}

function formatLogLine(line) {
    const parsed = parseLogLine(line);

    switch (parsed.type) {
        case 'l1-cache-hit':
            return `<span class="log-line log-l1-cache-hit" title="Click to copy">${escapeHtml(line)}</span>`;
        case 'l2-cache-hit':
            return `<span class="log-line log-l2-cache-hit" title="Click to copy">${escapeHtml(line)}</span>`;
        case 'cache-miss':
            return `<span class="log-line log-cache-miss" title="Click to copy">${escapeHtml(line)}</span>`;
        case 'cache-expired':
            return `<span class="log-line log-cache-expired" title="Click to copy">${escapeHtml(line)}</span>`;
        case 'upstream':
            return `<span class="log-line log-upstream" title="Click to copy">${escapeHtml(line)}</span>`;
        case 'ddos-protect':
            return `<span class="log-line log-ddos-protect" title="Click to copy">${escapeHtml(line)}</span>`;
        case 'circuit-breaker':
            return `<span class="log-line log-circuit-breaker" title="Click to copy">${escapeHtml(line)}</span>`;
        case 'request': {
            const methodClass = `method-${parsed.method.toLowerCase()}`;
            const statusGroup = Math.floor(parsed.status / 100);
            const statusClass = `status-${statusGroup}xx`;
            const errorLineClass = statusGroup >= 4 ? ' log-error-line' : '';

            let durationHtml = '';
            if (parsed.duration) {
                let durClass = 'log-duration duration-normal';
                if (parsed.durationMs < 50) durClass = 'log-duration duration-fast';
                else if (parsed.durationMs > 1000) durClass = 'duration-critical';
                else if (parsed.durationMs > 300) durClass = 'duration-slow';
                durationHtml = ` <span class="${durClass}">${escapeHtml(parsed.duration)}</span>`;
            }

            let ipHtml = '';
            if (parsed.ip && parsed.ip !== 'unknown') {
                ipHtml = ` <span class="log-ip" data-ip="${escapeHtml(parsed.ip)}" title="Filter by IP: ${escapeHtml(parsed.ip)}">[IP: ${escapeHtml(parsed.ip)}]</span>`;
            }

            return `<span class="log-line${errorLineClass}" title="Click to copy log"><span class="log-time">${escapeHtml(parsed.time)}</span>${ipHtml} <span class="log-method ${methodClass}">${escapeHtml(parsed.method)}</span> <span class="log-uri">${escapeHtml(parsed.uri)}</span> <span class="${statusClass}">${escapeHtml(parsed.statusStr)}</span>${durationHtml}</span>`;
        }
        default:
            return `<span class="log-line" title="Click to copy">${escapeHtml(line)}</span>`;
    }
}

function attachLogLineEvents(element, rawLine) {
    element.addEventListener('click', (e) => {
        // If clicking on IP address tag, filter by that IP
        const ipTag = e.target.closest('.log-ip');
        if (ipTag) {
            const ip = ipTag.getAttribute('data-ip');
            if (ip) {
                filterByIp(ip);
                return;
            }
        }
        // Otherwise copy raw line to clipboard
        navigator.clipboard.writeText(rawLine).then(() => {
            showToast("Copied log line to clipboard");
        }).catch(() => {});
    });
}

// ═══════════════════════════════════════════
// FILTERING & SEARCH ENGINE
// ═══════════════════════════════════════════
function linePassesFilters(line) {
    const searchInput = document.getElementById('search-filter');
    const query = searchInput ? searchInput.value.trim() : '';

    // Text or Regex Search Filter
    if (query) {
        if (query.startsWith('/') && query.endsWith('/') && query.length > 2) {
            try {
                const regex = new RegExp(query.slice(1, -1), 'i');
                if (!regex.test(line)) return false;
            } catch (e) {
                if (!line.toLowerCase().includes(query.toLowerCase())) return false;
            }
        } else {
            if (!line.toLowerCase().includes(query.toLowerCase())) return false;
        }
    }

    // Tab Filter
    if (filterTab !== 'all') {
        const parsed = parseLogLine(line);
        switch (filterTab) {
            case '2xx': return parsed.type === 'request' && parsed.status >= 200 && parsed.status < 300;
            case '3xx': return parsed.type === 'request' && parsed.status >= 300 && parsed.status < 400;
            case '4xx': return parsed.type === 'request' && parsed.status >= 400 && parsed.status < 500;
            case '5xx': return parsed.type === 'request' && parsed.status >= 500;
            case 'slow': return parsed.type === 'request' && parsed.durationMs > 300;
            case 'critical': return parsed.type === 'request' && parsed.durationMs > 1000;
            case 'cache': return parsed.type.includes('cache') || parsed.type === 'upstream';
            case 'security': return parsed.type === 'ddos-protect' || parsed.type === 'circuit-breaker' || (parsed.type === 'request' && parsed.status === 429);
        }
    }

    return true;
}

function applyAllFilters() {
    const outputContainer = document.getElementById('log-output');
    if (!outputContainer) return;

    const wasAtBottom = checkIsScrollAtBottom();

    // Recompute statistics from scratch on all loaded lines
    recomputeAllStats(originalLogLines);

    // Filter lines
    const matched = originalLogLines.filter(line => linePassesFilters(line));
    const renderSet = matched.slice(-MAX_DOM_LINES);

    if (renderSet.length === 0) {
        if (originalLogLines.length === 0) {
            showEmptyLogState();
        } else {
            outputContainer.innerHTML = '<div class="console-empty"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><div class="empty-title">No matching entries</div><div class="empty-desc">Try adjusting your search query or filter tabs</div></div>';
        }
        return;
    }

    const fragment = document.createDocumentFragment();
    for (let i = 0; i < renderSet.length; i++) {
        const line = renderSet[i];
        const div = document.createElement('div');
        div.innerHTML = formatLogLine(line);
        const node = div.firstChild;
        if (node) {
            attachLogLineEvents(node, line);
            fragment.appendChild(node);
        }
    }

    outputContainer.innerHTML = '';
    outputContainer.appendChild(fragment);

    if (isAutoScrollEnabled && wasAtBottom) {
        scrollToBottom();
    }

    updateScrollFab();
}

function debouncedApplyFilter() {
    const clearBtn = document.getElementById('clear-search-btn');
    const searchInput = document.getElementById('search-filter');
    if (clearBtn && searchInput) {
        clearBtn.style.display = searchInput.value ? 'block' : 'none';
    }

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        applyAllFilters();
    }, 120);
}

function clearSearch() {
    const searchInput = document.getElementById('search-filter');
    const clearBtn = document.getElementById('clear-search-btn');
    if (searchInput) searchInput.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
    applyAllFilters();
}

function setFilterTab(tab, element) {
    filterTab = tab;
    document.querySelectorAll('.filter-tab').forEach(el => el.classList.remove('active'));
    element.classList.add('active');
    applyAllFilters();
}

function filterByIp(ip) {
    const searchInput = document.getElementById('search-filter');
    const clearBtn = document.getElementById('clear-search-btn');
    if (searchInput) {
        searchInput.value = ip;
        if (clearBtn) clearBtn.style.display = 'block';
        applyAllFilters();
        showToast(`Filtered by IP: ${ip}`);
    }
}

// ═══════════════════════════════════════════
// STATISTICS & REAL-TIME THROUGHPUT ENGINE
// ═══════════════════════════════════════════
function resetStats() {
    stats = {
        totalRequests: 0,
        l1Hits: 0,
        l2Hits: 0,
        cacheMisses: 0,
        errors: 0,
        latencySum: 0,
        latencyCount: 0,
        uniqueIps15m: new Set(),
        uniqueIpsDaily: new Set()
    };
    renderStatsDisplay();
}

function ingestLineStats(line) {
    if (line.includes('[L1 CACHE HIT]')) stats.l1Hits++;
    else if (line.includes('[L2 CACHE HIT]') || line.includes('[CACHE HIT]')) stats.l2Hits++;
    else if (line.includes('[CACHE MISS]')) stats.cacheMisses++;

    const parsed = parseLogLine(line);
    if (parsed.type === 'request') {
        stats.totalRequests++;
        if (parsed.status >= 400) stats.errors++;
        if (parsed.durationMs > 0) {
            stats.latencySum += parsed.durationMs;
            stats.latencyCount++;
        }
        if (parsed.ip && parsed.ip !== 'unknown') {
            stats.uniqueIpsDaily.add(parsed.ip);
            stats.uniqueIps15m.add(parsed.ip);
        }
    }
}

function scheduleStatsUpdate() {
    if (!statsDebounceTimer) {
        statsDebounceTimer = setTimeout(() => {
            renderStatsDisplay();
            statsDebounceTimer = null;
        }, 300);
    }
}

function recomputeAllStats(lines) {
    resetStats();
    const now = Date.now();
    for (let i = 0; i < lines.length; i++) {
        ingestLineStats(lines[i]);
    }
    renderStatsDisplay();
}

function renderStatsDisplay() {
    const totalCacheQueries = stats.l1Hits + stats.l2Hits + stats.cacheMisses;
    const hitRate = totalCacheQueries > 0 ? Math.round(((stats.l1Hits + stats.l2Hits) / totalCacheQueries) * 100) : 0;
    const avgLatency = stats.latencyCount > 0 ? Math.round(stats.latencySum / stats.latencyCount) : 0;
    const errorRate = stats.totalRequests > 0 ? Math.round((stats.errors / stats.totalRequests) * 100) : 0;

    const elTotal = document.getElementById('stat-total');
    const elUsers = document.getElementById('stat-users');
    const elDailyUsers = document.getElementById('stat-daily-users');
    const elCacheRate = document.getElementById('stat-cache-rate');
    const elL1 = document.getElementById('stat-l1-hits');
    const elL2 = document.getElementById('stat-l2-hits');
    const elLatency = document.getElementById('stat-latency');
    const elErrors = document.getElementById('stat-errors');

    if (elTotal) elTotal.innerText = stats.totalRequests.toLocaleString();
    if (elUsers) elUsers.innerText = stats.uniqueIps15m.size.toLocaleString();
    if (elDailyUsers) elDailyUsers.innerText = stats.uniqueIpsDaily.size.toLocaleString();
    if (elCacheRate) elCacheRate.innerText = hitRate + '%';
    if (elL1) elL1.innerText = stats.l1Hits.toLocaleString();
    if (elL2) elL2.innerText = stats.l2Hits.toLocaleString();
    if (elLatency) elLatency.innerText = avgLatency + 'ms';
    if (elErrors) elErrors.innerText = errorRate + '%';
}

function updateRpsMeter() {
    const now = Date.now();
    // Keep timestamps from the last 2 seconds
    rpsWindow = rpsWindow.filter(t => (now - t) <= 2000);
    const rps = Math.round(rpsWindow.length / 2);
    const elRps = document.getElementById('stat-rps');
    if (elRps) {
        elRps.innerText = `${rps} req/s`;
    }
}

// ═══════════════════════════════════════════
// STREAM & SCROLL CONTROLS
// ═══════════════════════════════════════════
function toggleStreamPause() {
    isStreamPaused = !isStreamPaused;
    const btn = document.getElementById('stream-toggle-btn');
    const text = document.getElementById('stream-btn-text');
    const pauseIcon = btn ? btn.querySelector('.pause-icon') : null;
    const playIcon = btn ? btn.querySelector('.play-icon') : null;

    if (isStreamPaused) {
        if (btn) {
            btn.classList.remove('active');
            btn.classList.add('paused');
        }
        if (text) text.innerText = 'Paused';
        if (pauseIcon) pauseIcon.style.display = 'none';
        if (playIcon) playIcon.style.display = 'inline-block';
        showToast("Live stream paused");
    } else {
        if (btn) {
            btn.classList.remove('paused');
            btn.classList.add('active');
        }
        if (text) text.innerText = 'Streaming';
        if (pauseIcon) pauseIcon.style.display = 'inline-block';
        if (playIcon) playIcon.style.display = 'none';

        unreadPausedCount = 0;
        updatePausedBadge();
        applyAllFilters();
        scrollToBottom();
        showToast("Live stream resumed");
    }
}

function updatePausedBadge() {
    const badge = document.getElementById('paused-count-badge');
    if (badge) {
        if (isStreamPaused && unreadPausedCount > 0) {
            badge.innerText = `+${unreadPausedCount}`;
            badge.style.display = 'inline-block';
        } else {
            badge.style.display = 'none';
        }
    }
}

function toggleAutoScroll() {
    isAutoScrollEnabled = !isAutoScrollEnabled;
    const btn = document.getElementById('autoscroll-toggle-btn');
    if (btn) {
        btn.classList.toggle('active', isAutoScrollEnabled);
    }
    if (isAutoScrollEnabled) {
        scrollToBottom();
        showToast("Auto-scroll enabled");
    } else {
        showToast("Auto-scroll disabled");
    }
}

function handleUserScroll() {
    const atBottom = checkIsScrollAtBottom();
    updateScrollFab();
}

function checkIsScrollAtBottom() {
    const el = document.getElementById('console-scroll');
    if (!el) return true;
    return (el.scrollHeight - el.scrollTop - el.clientHeight) < 60;
}

function scrollToBottom() {
    const el = document.getElementById('console-scroll');
    if (el) {
        el.scrollTop = el.scrollHeight;
    }
    unreadPausedCount = 0;
    updatePausedBadge();
    updateScrollFab();
}

function updateScrollFab() {
    const fab = document.getElementById('scroll-fab');
    const badge = document.getElementById('unread-fab-count');
    if (!fab) return;

    const atBottom = checkIsScrollAtBottom();
    fab.classList.toggle('visible', !atBottom || isStreamPaused);

    if (badge) {
        if (unreadPausedCount > 0) {
            badge.innerText = `+${unreadPausedCount}`;
            badge.style.display = 'inline-block';
        } else {
            badge.style.display = 'none';
        }
    }
}

// ═══════════════════════════════════════════
// ACTIONS (CLEAR, DOWNLOAD, TOAST)
// ═══════════════════════════════════════════
function clearConsole() {
    originalLogLines = [];
    incomingBatch = [];
    resetStats();
    const outputContainer = document.getElementById('log-output');
    if (outputContainer) outputContainer.innerHTML = '';
    showEmptyLogState();
    showToast("Console view cleared");
}

async function clearServerLogs() {
    if (!activeFile) return;

    const confirmed = confirm(`Are you sure you want to permanently clear the log file "${activeFile}" on the server?\n\nThis action cannot be undone.`);
    if (!confirmed) return;

    try {
        const response = await fetch('/api/logs/clear', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: logsPassword, file_name: activeFile })
        });

        const result = await response.json();
        if (result.success) {
            clearConsole();
            connectLogsWs();
            showToast("Server log file cleared");
        } else {
            alert('Failed to clear log file: ' + (result.message || 'Unknown error'));
        }
    } catch (err) {
        console.error('Error clearing log file:', err);
        alert('Failed to clear log file.');
    }
}

function downloadLogs() {
    if (!activeFile || originalLogLines.length === 0) {
        showToast("No logs available to download");
        return;
    }
    const matched = originalLogLines.filter(line => linePassesFilters(line));
    const text = matched.join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `filtered_${activeFile}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Downloaded ${matched.length} log lines`);
}

function showToast(message) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.innerText = message;
    toast.classList.add('show');
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => {
        toast.classList.remove('show');
    }, 2200);
}

// ═══════════════════════════════════════════
// UI STATES
// ═══════════════════════════════════════════
function showLoadingState() {
    const outputContainer = document.getElementById('log-output');
    if (outputContainer) {
        outputContainer.innerHTML = '<div class="console-empty" id="loading-state"><div class="loading-spinner"></div><div class="empty-title">Loading logs...</div><div class="empty-desc">Connecting to stream and fetching latest tail data</div></div>';
    }
}

function showEmptyLogState() {
    const outputContainer = document.getElementById('log-output');
    if (outputContainer) {
        outputContainer.innerHTML = '<div class="console-empty" id="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><div class="empty-title">Log file is empty</div><div class="empty-desc">No entries recorded yet. New requests will appear here in real-time.</div></div>';
    }
}

function showErrorState(msg) {
    const outputContainer = document.getElementById('log-output');
    if (outputContainer) {
        outputContainer.innerHTML = `<div class="console-empty" id="error-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="1.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><div class="empty-title" style="color: var(--danger);">Connection Error</div><div class="empty-desc">${escapeHtml(msg)}</div></div>`;
    }
}

function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// ═══════════════════════════════════════════
// BANNED IPS & DDOS MODAL
// ═══════════════════════════════════════════
async function openBannedModal() {
    document.getElementById('banned-modal').style.display = 'flex';
    const list = document.getElementById('banned-ip-list');
    list.innerHTML = '<div style="text-align:center; padding:1.5rem; color:var(--text-muted);"><div class="loading-spinner" style="margin:0 auto 0.5rem;"></div>Fetching banned IP list...</div>';
    try {
        const res = await fetch('/api/logs/bans', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({password: logsPassword})
        });
        if (res.ok) {
            const data = await res.json();
            if (data.success) renderBannedIps(data.data);
            else list.innerHTML = `<div style="color:var(--danger); padding: 1rem;">${escapeHtml(data.message)}</div>`;
        }
    } catch (err) {
        list.innerHTML = '<div style="color:var(--danger); padding: 1rem;">Error fetching banned IPs.</div>';
    }
}

function closeBannedModal() {
    document.getElementById('banned-modal').style.display = 'none';
}

function renderBannedIps(ips) {
    const list = document.getElementById('banned-ip-list');
    if (!ips || ips.length === 0) {
        list.innerHTML = '<div style="text-align:center; padding:1.5rem; color:var(--success);">✅ No IPs are currently banned. System is clean.</div>';
        return;
    }
    list.innerHTML = ips.map(ip => `
        <div class="banned-ip-item" id="ban-${escapeHtml(ip)}">
            <div class="ip-addr">${escapeHtml(ip)}</div>
            <div>
                <button class="view-behavior-btn" data-ip="${escapeHtml(ip)}">Inspect Logs</button>
                <button class="unban-ip-btn" data-ip="${escapeHtml(ip)}" style="color: var(--danger);">Unban</button>
            </div>
        </div>
    `).join('');

    list.querySelectorAll('.view-behavior-btn').forEach(btn => {
        btn.onclick = () => {
            closeBannedModal();
            filterByIp(btn.getAttribute('data-ip'));
        };
    });
    list.querySelectorAll('.unban-ip-btn').forEach(btn => {
        btn.onclick = () => unbanIp(btn.getAttribute('data-ip'));
    });
}

async function unbanIp(ip) {
    if (!confirm(`Are you sure you want to unban IP: ${ip}?`)) return;
    try {
        const res = await fetch('/api/logs/unban', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({password: logsPassword, ip: ip})
        });
        if (res.ok) {
            const data = await res.json();
            if (data.success) {
                const el = document.getElementById(`ban-${ip}`);
                if (el) el.remove();
                showToast(`Unbanned IP: ${ip}`);
            } else alert(data.message);
        }
    } catch (e) {
        alert("Error unbanning IP.");
    }
}