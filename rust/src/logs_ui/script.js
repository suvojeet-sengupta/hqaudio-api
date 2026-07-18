// ═══════════════════════════════════════════
        // STATE
        // ═══════════════════════════════════════════
        let logsPassword = localStorage.getItem('logs_password') || '';
        let activeFile = '';
        let originalLogLines = [];
        let filesList = [];
        let ws = null;
        let reconnectTimeout = null;
        let reconnectAttempts = 0;
        let filterTab = 'all';
        let debounceTimer = null;
        let isLoading = false;

        // ═══════════════════════════════════════════
        // INIT
        // ═══════════════════════════════════════════
        if (logsPassword) {
            testAuthAndInitialize();
        }

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Ctrl+L = Clear console
            if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
                e.preventDefault();
                clearConsole();
            }
            // Ctrl+K = Focus search
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                document.getElementById('search-filter').focus();
            }
            // Escape = Close sidebar
            if (e.key === 'Escape') {
                closeSidebar();
            }
        });

        // Track scroll position for scroll-to-bottom FAB
        document.addEventListener('DOMContentLoaded', () => {
            const consoleEl = document.getElementById('console-scroll');
            if (consoleEl) {
                consoleEl.addEventListener('scroll', updateScrollFab);
            }
        });

        // ═══════════════════════════════════════════
        // AUTH
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
                    // Trigger reflow for animation
                    void dashboard.offsetWidth;
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
        // SIDEBAR
        // ═══════════════════════════════════════════
        function openSidebar() {
            document.getElementById('sidebar').classList.add('open');
            document.getElementById('backdrop').style.display = 'block';
        }

        function closeSidebar() {
            document.getElementById('sidebar').classList.remove('open');
            document.getElementById('backdrop').style.display = 'none';
        }

        // ═══════════════════════════════════════════
        // FILE LIST
        // ═══════════════════════════════════════════
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

                    // Auto-select the first (latest) file
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
            if (element) element.classList.add('active');
            document.getElementById('active-filename').innerText = filename;

            // Show loading state
            showLoadingState();

            // Connect WebSocket for this file
            connectLogsWs();
        }

        // ═══════════════════════════════════════════
        // CONNECTION STATUS
        // ═══════════════════════════════════════════
        function updateConnectionStatus(status) {
            const badge = document.getElementById('connection-status');
            const text = document.getElementById('status-text');

            switch (status) {
                case 'live':
                    badge.className = 'status-badge live';
                    text.innerText = 'Live';
                    break;
                case 'history':
                    badge.className = 'status-badge';
                    text.innerText = 'History';
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

        // ═══════════════════════════════════════════
        // WEBSOCKET
        // ═══════════════════════════════════════════
        function connectLogsWs() {
            if (!activeFile) return;

            // Close existing socket
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
                    // Initial dump of log file
                    const content = message.slice(15);
                    originalLogLines = content.split('\n').filter(line => line.trim() !== '');
                    applyAllFilters();

                    // If no lines, show empty state
                    if (originalLogLines.length === 0) {
                        showEmptyLogState();
                    }
                } else if (message.startsWith('[SYSTEM]')) {
                    // System warning messages (e.g. dropped messages due to slow connection)
                    const outputContainer = document.getElementById('log-output');
                    const div = document.createElement('div');
                    div.innerHTML = `<span class="log-line" style="color: var(--warning); background: var(--warning-bg);">${escapeHtml(message)}</span>`;
                    const node = div.firstChild;
                    if (node) outputContainer.appendChild(node);
                    if (checkIsScrollAtBottom()) scrollToBottom();
                } else if (message.startsWith('[SYS_STATUS]')) {
                    try {
                        const sys = JSON.parse(message.slice(12));
                        document.getElementById('stat-cache-sys').innerText = sys.cache_system || 'Unknown';
                        document.getElementById('stat-redis-sys').innerText = sys.redis || 'Unknown';
                        document.getElementById('stat-db-sys').innerText = sys.db || 'Unknown';
                        
                        if (sys.ddos_protection) {
                            document.getElementById('stat-ddos-sys').innerText = sys.ddos_protection;
                        }
                        if (sys.banned_ips !== undefined) {
                            document.getElementById('stat-banned-ips').innerText = sys.banned_ips;
                        }
                    } catch (e) {
                        console.error("Failed to parse system status", e);
                    }
                } else {
                    // Live streamed log line
                    const wasAtBottom = checkIsScrollAtBottom();

                    originalLogLines.push(message);

                    // Check if this line passes all current filters
                    if (linePassesFilters(message)) {
                        const outputContainer = document.getElementById('log-output');

                        // Clear empty/loading/error states
                        const emptyState = document.getElementById('empty-state');
                        const loadingState = document.getElementById('loading-state');
                        const errorState = document.getElementById('error-state');
                        if (emptyState) emptyState.remove();
                        if (loadingState) loadingState.remove();
                        if (errorState) errorState.remove();

                        const div = document.createElement('div');
                        div.innerHTML = formatLogLine(message);
                        const node = div.firstChild;
                        if (node) outputContainer.appendChild(node);
                    }

                    // Recalculate stats
                    calculateStats(originalLogLines);

                    if (wasAtBottom) {
                        scrollToBottom();
                    }

                    updateScrollFab();
                }
            };

            ws.onclose = (event) => {
                const reason = event.reason || '';
                if (event.code === 4001 || reason.includes('Unauthorized')) {
                    logout();
                    return;
                }

                // Only reconnect for today's (live) file with exponential backoff
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

        // ═══════════════════════════════════════════
        // LOG PARSING & FORMATTING
        // ═══════════════════════════════════════════

        /**
         * Parse a log line with format:
         * [YYYY-MM-DD HH:MM:SS] [IP: xxx] METHOD /uri STATUS DURATIONms
         * or special lines like [CACHE HIT], [CACHE MISS], etc.
         */
        function parseLogLine(line) {
            // Match special log types
            if (line.includes('[CACHE HIT]')) return { type: 'cache-hit', raw: line };
            if (line.includes('[CACHE MISS]')) return { type: 'cache-miss', raw: line };
            if (line.includes('[CACHE EXPIRED]')) return { type: 'cache-expired', raw: line };
            if (line.includes('[UPSTREAM FETCH SUCCESS]')) return { type: 'upstream', raw: line };

            // Parse request log: [YYYY-MM-DD HH:MM:SS] [IP: xxx] [UA: xxx] METHOD /uri STATUS DURATIONms SIZEB
            const match = line.match(/^(\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\])\s+(?:\[IP:\s*([^\]]+)\]\s+)?(?:\[UA:\s*([^\]]+)\]\s+)?(\w+)\s+(\S+)\s+(\d{3})\s+(\d+ms)(?:\s+(\d+)B)?$/);
            if (match) {
                return {
                    type: 'request',
                    raw: line,
                    time: match[1],
                    ip: match[2] || 'unknown',
                    ua: match[3] || 'unknown',
                    method: match[4],
                    uri: match[5],
                    status: parseInt(match[6], 10),
                    statusStr: match[6],
                    duration: match[7],
                    durationMs: parseInt(match[7], 10),
                    sizeBytes: match[8] || '0'
                };
            }

            // Fallback: try a looser match for lines that might have extra content
            const looseMatch = line.match(/^(\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\])\s+(\w+)\s+(\S+)\s+(\d{3})\s*(.*)$/);
            if (looseMatch) {
                const durMatch = (looseMatch[5] || '').match(/(\d+)ms/);
                return {
                    type: 'request',
                    raw: line,
                    time: looseMatch[1],
                    method: looseMatch[2],
                    uri: looseMatch[3],
                    status: parseInt(looseMatch[4], 10),
                    statusStr: looseMatch[4],
                    duration: durMatch ? durMatch[0] : '',
                    durationMs: durMatch ? parseInt(durMatch[1], 10) : 0
                };
            }

            return { type: 'unknown', raw: line };
        }

        function formatLogLine(line) {
            const parsed = parseLogLine(line);

            switch (parsed.type) {
                case 'cache-hit':
                    return `<span class="log-line log-cache-hit">${escapeHtml(line)}</span>`;
                case 'cache-miss':
                    return `<span class="log-line log-cache-miss">${escapeHtml(line)}</span>`;
                case 'cache-expired':
                    return `<span class="log-line log-cache-expired">${escapeHtml(line)}</span>`;
                case 'upstream':
                    return `<span class="log-line log-upstream">${escapeHtml(line)}</span>`;
                case 'request': {
                    const methodClass = `method-${parsed.method.toLowerCase()}`;
                    const statusGroup = Math.floor(parsed.status / 100);
                    const statusClass = `status-${statusGroup}xx`;
                    const errorLineClass = statusGroup >= 4 ? ' log-error-line' : '';

                    let durationHtml = '';
                    if (parsed.duration) {
                        let durClass = 'log-duration';
                        if (parsed.durationMs > 1000) durClass = 'duration-critical';
                        else if (parsed.durationMs > 300) durClass = 'duration-slow';
                        durationHtml = ` <span class="${durClass}">${escapeHtml(parsed.duration)}</span>`;
                    }

                    let ipHtml = '';
                    if (parsed.ip && parsed.ip !== 'unknown') {
                        ipHtml = ` <span class="log-ip">[IP: ${escapeHtml(parsed.ip)}]</span>`;
                    }

                    return `<span class="log-line${errorLineClass}"><span class="log-time">${escapeHtml(parsed.time)}</span>${ipHtml} <span class="log-method ${methodClass}">${escapeHtml(parsed.method)}</span> <span class="log-uri">${escapeHtml(parsed.uri)}</span> <span class="${statusClass}">${escapeHtml(parsed.statusStr)}</span>${durationHtml}</span>`;
                }
                default:
                    return `<span class="log-line">${escapeHtml(line)}</span>`;
            }
        }

        // ═══════════════════════════════════════════
        // FILTERING
        // ═══════════════════════════════════════════
        function linePassesFilters(line) {
            // Text search filter
            const query = document.getElementById('search-filter').value.toLowerCase().trim();
            if (query && !line.toLowerCase().includes(query)) return false;

            // Tab filter
            if (filterTab !== 'all') {
                const parsed = parseLogLine(line);
                switch (filterTab) {
                    case '2xx': return parsed.type === 'request' && parsed.status >= 200 && parsed.status < 300;
                    case '3xx': return parsed.type === 'request' && parsed.status >= 300 && parsed.status < 400;
                    case '4xx': return parsed.type === 'request' && parsed.status >= 400 && parsed.status < 500;
                    case '5xx': return parsed.type === 'request' && parsed.status >= 500;
                    case 'slow': return parsed.type === 'request' && parsed.durationMs > 500;
                    case 'cache': return parsed.type === 'cache-hit' || parsed.type === 'cache-miss' || parsed.type === 'cache-expired';
                }
            }

            return true;
        }

        function applyAllFilters() {
            const outputContainer = document.getElementById('log-output');
            const wasAtBottom = checkIsScrollAtBottom();

            // Calculate stats on ALL lines (unfiltered)
            calculateStats(originalLogLines);

            // Apply filters
            const matchedLines = originalLogLines.filter(line => linePassesFilters(line));

            if (matchedLines.length === 0) {
                if (originalLogLines.length === 0) {
                    showEmptyLogState();
                } else {
                    outputContainer.innerHTML = '<div class="console-empty"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><div class="empty-title">No matching entries</div><div class="empty-desc">Try adjusting your search query or filter tabs</div></div>';
                }
                return;
            }

            // Use document fragment for performance
            const fragment = document.createDocumentFragment();
            const tempDiv = document.createElement('div');

            // For very large log sets, batch render
            const html = matchedLines.map(line => formatLogLine(line)).join('');
            tempDiv.innerHTML = html;
            while (tempDiv.firstChild) {
                fragment.appendChild(tempDiv.firstChild);
            }

            outputContainer.innerHTML = '';
            outputContainer.appendChild(fragment);

            if (wasAtBottom) {
                scrollToBottom();
            }

            updateScrollFab();
        }

        function debouncedApplyFilter() {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                applyAllFilters();
            }, 150);
        }

        function setFilterTab(tab, element) {
            filterTab = tab;
            document.querySelectorAll('.filter-tab').forEach(el => el.classList.remove('active'));
            element.classList.add('active');
            applyAllFilters();
        }

        // ═══════════════════════════════════════════
        // STATS CALCULATION
        // ═══════════════════════════════════════════
        function calculateStats(lines) {
            let totalRequests = 0;
            let cacheHits = 0;
            let cacheMisses = 0;
            let totalLatency = 0;
            let latencyCount = 0;
            let errors = 0;
            let uniqueIps15m = new Set();
            let uniqueIpsDaily = new Set();
            const now = new Date();

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line.includes('[CACHE HIT]')) cacheHits++;
                if (line.includes('[CACHE MISS]')) cacheMisses++;

                const parsed = parseLogLine(line);
                if (parsed.type === 'request') {
                    totalRequests++;
                    if (parsed.status >= 400) errors++;
                    if (parsed.durationMs > 0) {
                        totalLatency += parsed.durationMs;
                        latencyCount++;
                    }
                    if (parsed.ip && parsed.ip !== 'unknown') {
                        uniqueIpsDaily.add(parsed.ip);
                        
                        if (parsed.time) {
                            // Parse timestamp correctly as IST (+05:30)
                            const timeStr = parsed.time.slice(1, -1).replace(' ', 'T') + '+05:30';
                            const logDate = new Date(timeStr);
                            if (!isNaN(logDate.getTime())) {
                                const diffMins = (now - logDate) / (1000 * 60);
                                if (diffMins >= 0 && diffMins <= 15) {
                                    uniqueIps15m.add(parsed.ip);
                                }
                            }
                        }
                    }
                }
            }

            const hitRate = (cacheHits + cacheMisses > 0) ? Math.round((cacheHits / (cacheHits + cacheMisses)) * 100) : 0;
            const avgLatency = latencyCount > 0 ? Math.round(totalLatency / latencyCount) : 0;
            const errorRate = totalRequests > 0 ? Math.round((errors / totalRequests) * 100) : 0;

            document.getElementById('stat-total').innerText = totalRequests.toLocaleString();
            document.getElementById('stat-users').innerText = uniqueIps15m.size.toLocaleString();
            
            const dailyUsersEl = document.getElementById('stat-daily-users');
            if (dailyUsersEl) dailyUsersEl.innerText = uniqueIpsDaily.size.toLocaleString();
            
            document.getElementById('stat-cache-rate').innerText = hitRate + '%';
            document.getElementById('stat-latency').innerText = avgLatency + 'ms';
            document.getElementById('stat-errors').innerText = errorRate + '%';
        }

        // ═══════════════════════════════════════════
        // UI STATES
        // ═══════════════════════════════════════════
        function showLoadingState() {
            const outputContainer = document.getElementById('log-output');
            outputContainer.innerHTML = '<div class="console-empty" id="loading-state"><div class="loading-spinner"></div><div class="empty-title">Loading logs...</div><div class="empty-desc">Connecting to server and fetching log data</div></div>';
        }

        function showEmptyLogState() {
            const outputContainer = document.getElementById('log-output');
            outputContainer.innerHTML = '<div class="console-empty" id="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><div class="empty-title">Log file is empty</div><div class="empty-desc">No entries recorded yet. New requests will appear here in real-time.</div></div>';
        }

        function showErrorState(msg) {
            const outputContainer = document.getElementById('log-output');
            outputContainer.innerHTML = `<div class="console-empty" id="error-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="1.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><div class="empty-title" style="color: var(--danger);">Connection Error</div><div class="empty-desc">${escapeHtml(msg)}</div></div>`;
        }

        // ═══════════════════════════════════════════
        // SCROLL MANAGEMENT
        // ═══════════════════════════════════════════
        function checkIsScrollAtBottom() {
            const el = document.getElementById('console-scroll');
            return (el.scrollHeight - el.scrollTop - el.clientHeight) < 80;
        }

        function scrollToBottom() {
            const el = document.getElementById('console-scroll');
            el.scrollTop = el.scrollHeight;
            updateScrollFab();
        }

        function updateScrollFab() {
            const fab = document.getElementById('scroll-fab');
            if (!fab) return;
            const atBottom = checkIsScrollAtBottom();
            fab.classList.toggle('visible', !atBottom);
        }

        // ═══════════════════════════════════════════
        // ACTIONS
        // ═══════════════════════════════════════════
        function clearConsole() {
            originalLogLines = [];
            const outputContainer = document.getElementById('log-output');
            outputContainer.innerHTML = '';
            calculateStats([]);
            showEmptyLogState();
        }

        async function clearServerLogs() {
            if (!activeFile) return;

            const confirmed = confirm(`Are you sure you want to permanently clear the log file "${activeFile}"?\n\nThis action cannot be undone.`);
            if (!confirmed) return;

            try {
                const response = await fetch('/api/logs/clear', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: logsPassword, file_name: activeFile })
                });

                const result = await response.json();
                if (result.success) {
                    // Clear UI and reconnect to get fresh (empty) state
                    clearConsole();
                    connectLogsWs();
                } else {
                    alert('Failed to clear log file: ' + (result.message || 'Unknown error'));
                }
            } catch (err) {
                console.error('Error clearing log file:', err);
                alert('Failed to clear log file. Check console for details.');
            }
        }

        function downloadLogs() {
            if (!activeFile || originalLogLines.length === 0) return;
            const text = originalLogLines.join('\n');
            const blob = new Blob([text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = activeFile;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }

        // ═══════════════════════════════════════════
        // UTILITIES
        // ═══════════════════════════════════════════
        function escapeHtml(text) {
            if (!text) return '';
            return text
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        }

        function getTodayStr() {
            return new Date().toISOString().split('T')[0];
        }

        // ═══════════════════════════════════════════
        // MODALS & BAN MANAGEMENT
        // ═══════════════════════════════════════════
        async function openBannedModal() {
            document.getElementById('banned-modal').style.display = 'flex';
            const list = document.getElementById('banned-ip-list');
            list.innerHTML = '<div style="text-align:center; padding:1rem; color:var(--text-muted);">Loading...</div>';
            try {
                const res = await fetch('/api/logs/bans', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({password: logsPassword})
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data.success) renderBannedIps(data.data);
                    else list.innerHTML = `<div style="color:var(--danger);">${escapeHtml(data.message)}</div>`;
                }
            } catch (err) {
                list.innerHTML = '<div style="color:var(--danger);">Error fetching bans.</div>';
            }
        }
        function closeBannedModal() {
            document.getElementById('banned-modal').style.display = 'none';
        }
        function renderBannedIps(ips) {
            const list = document.getElementById('banned-ip-list');
            if (!ips || ips.length === 0) {
                list.innerHTML = '<div style="text-align:center; padding:1rem; color:var(--success);">No IPs are currently banned.</div>';
                return;
            }
            list.innerHTML = ips.map(ip => `
                <div class="banned-ip-item" id="ban-${escapeHtml(ip)}">
                    <div class="ip-addr">${escapeHtml(ip)}</div>
                    <div>
                        <button class="view-behavior-btn" data-ip="${escapeHtml(ip)}">View Behavior</button>
                        <button class="unban-ip-btn" data-ip="${escapeHtml(ip)}">Unban</button>
                    </div>
                </div>
            `).join('');

            // Attach event listeners safely
            list.querySelectorAll('.view-behavior-btn').forEach(btn => {
                btn.onclick = () => filterByIp(btn.getAttribute('data-ip'));
            });
            list.querySelectorAll('.unban-ip-btn').forEach(btn => {
                btn.onclick = () => unbanIp(btn.getAttribute('data-ip'));
            });
        }
        function filterByIp(ip) {
            closeBannedModal();
            const searchInput = document.getElementById('search-filter');
            searchInput.value = ip;
            applyAllFilters();
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
                    } else alert(data.message);
                }
            } catch (e) {
                alert("Error unbanning IP.");
            }
        }