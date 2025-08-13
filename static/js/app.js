// Global variables
let ws = null;
let canvas = document.getElementById('pixelCanvas');
let ctx = canvas.getContext('2d');
let selectedColor = '#FF0000';
let userId = 'user_' + Math.random().toString(36).substr(2, 9);

// Camera and viewport
let zoom = 1;
let cameraX = 4096; // Start at center of 8192x8192 canvas  
let cameraY = 4096;
let isDragging = false;
let lastMouseX = 0;
let lastMouseY = 0;

// Pixel bag system
let pixelBag = 0;
let maxPixelBag = 10;
let lastPixelTime = 0;
let bagRefillInterval = null;
let loadedRegions = new Set();
let pixelData = new Map(); // Store all loaded pixels

// Connection state
let mouseWorldX = 0;
let mouseWorldY = 0;
let ping = 0;
let lastPingTime = Date.now();
let userCount = 0;

// Chat rate limiting
let lastChatTime = 0;
const CHAT_COOLDOWN = 3000; // 3 seconds between messages

// Canvas setup
const CANVAS_SIZE = 8192;
const REGION_SIZE = 512;
const PIXEL_SIZE = 1; // Each pixel is 1x1 on canvas, zoom handles scaling
const PIXEL_REFILL_RATE = 3000; // 3 seconds per pixel

// Color palette - Basic 16 colors
const colors = [
    '#FF0000', '#00FF00', '#0000FF', '#FFFF00',
    '#FF00FF', '#00FFFF', '#FFFFFF', '#000000',
    '#800000', '#008000', '#000080', '#808000',
    '#800080', '#008080', '#C0C0C0', '#808080'
];

// Initialize application
function init() {
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
        return;
    }

    // Get canvas reference again after DOM is ready
    canvas = document.getElementById('pixelCanvas');
    ctx = canvas.getContext('2d');

    setupCanvas();
    setupColorPalette();
    connectWebSocket();
    setupEventListeners();
    startPixelBagSystem();

    // Set initial zoom to be much smaller for better overview
    const zoomX = canvas.width / CANVAS_SIZE;
    const zoomY = canvas.height / CANVAS_SIZE;
    zoom = Math.max(zoomX, zoomY) * 50; // Much smaller initial zoom for better overview

    cameraX = CANVAS_SIZE / 2;
    cameraY = CANVAS_SIZE / 2;

    adjustCameraBounds();
    updateVisibleRegions();

    // Initialize UI
    updateStatus('Connecting...', 'connecting');
    updatePixelBagDisplay();
}

function setupCanvas() {
    // Set canvas to full viewport size (floating palette doesn't take space)
    const container = document.querySelector('.canvas-container');
    const rect = container.getBoundingClientRect();

    canvas.width = rect.width;
    canvas.height = rect.height;

    // Fill with light background
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Set rendering options for pixel art
    ctx.imageSmoothingEnabled = false;
    ctx.webkitImageSmoothingEnabled = false;
    ctx.mozImageSmoothingEnabled = false;

    // Handle window resize
    window.addEventListener('resize', () => {
        const newRect = container.getBoundingClientRect();
        canvas.width = newRect.width;
        canvas.height = newRect.height;

        // Maintain zoom level but adjust camera bounds
        adjustCameraBounds();
        renderCanvas();
    });
}

function adjustCameraBounds() {
    // Calculate max zoom to prevent seeing beyond canvas edges
    const maxZoomX = canvas.width / CANVAS_SIZE;
    const maxZoomY = canvas.height / CANVAS_SIZE;
    const maxZoom = Math.max(maxZoomX, maxZoomY);

    // Limit minimum zoom to prevent seeing beyond edges
    zoom = Math.max(maxZoom, zoom);

    // Recalculate view dimensions with corrected zoom
    const newViewWidth = canvas.width / zoom;
    const newViewHeight = canvas.height / zoom;

    // Clamp camera to ensure canvas always fills viewport
    cameraX = Math.max(newViewWidth / 2, Math.min(CANVAS_SIZE - newViewWidth / 2, cameraX));
    cameraY = Math.max(newViewHeight / 2, Math.min(CANVAS_SIZE - newViewHeight / 2, cameraY));
}

function setupColorPalette() {
    const colorGrid = document.getElementById('colorGrid');
    colors.forEach((color, index) => {
        const colorBtn = document.createElement('div');
        colorBtn.className = 'color-btn';
        if (index === 0) colorBtn.classList.add('selected');
        colorBtn.style.backgroundColor = color;
        colorBtn.onclick = () => selectColor(color, colorBtn);
        colorGrid.appendChild(colorBtn);
    });
}

function selectColor(color, element) {
    selectedColor = color;
    document.querySelectorAll('.color-btn').forEach(btn => btn.classList.remove('selected'));
    element.classList.add('selected');
}

function toggleColorPalette() {
    const palette = document.getElementById('colorPaletteFixed');
    const toggleText = document.getElementById('colorPaletteToggle').querySelector('.palette-text');
    const isMinimized = palette.classList.contains('minimized');

    if (isMinimized) {
        // Expand: show drawer
        palette.classList.remove('minimized');
        palette.classList.add('expanded');
        toggleText.textContent = 'Colors';
    } else {
        // Minimize: hide drawer
        palette.classList.remove('expanded');
        palette.classList.add('minimized');
        // Show pixel count when minimized
        toggleText.textContent = `${pixelBag}/${maxPixelBag} pixels`;
    }
}

// Pixel Bag System
function startPixelBagSystem() {
    // Start with 3 pixels
    pixelBag = 3;
    updatePixelBagDisplay();

    // Refill bag every 3 seconds
    bagRefillInterval = setInterval(() => {
        if (pixelBag < maxPixelBag) {
            pixelBag++;
            updatePixelBagDisplay();
        }
    }, PIXEL_REFILL_RATE);
}

function updatePixelBagDisplay() {
    const pixelCount = document.getElementById('pixelCount');
    const bagFill = document.getElementById('bagFill');

    pixelCount.textContent = `${pixelBag}/${maxPixelBag}`;

    const fillPercentage = (pixelBag / maxPixelBag) * 100;
    bagFill.style.width = fillPercentage + '%';

    // Change color based on bag level
    if (pixelBag === 0) {
        bagFill.style.background = 'var(--error)';
    } else if (pixelBag < maxPixelBag / 3) {
        bagFill.style.background = 'var(--warning)';
    } else {
        bagFill.style.background = 'linear-gradient(90deg, var(--accent), var(--success))';
    }

    // Update palette toggle text if minimized
    const palette = document.getElementById('colorPaletteFixed');
    const toggleText = document.getElementById('colorPaletteToggle').querySelector('.palette-text');
    if (palette.classList.contains('minimized')) {
        toggleText.textContent = `${pixelBag}/${maxPixelBag} pixels`;
    }
}

function updateVisibleRegions() {
    // Calculate which regions are visible based on camera position and zoom
    const viewWidth = canvas.width / zoom;
    const viewHeight = canvas.height / zoom;

    const leftX = cameraX - viewWidth / 2;
    const rightX = cameraX + viewWidth / 2;
    const topY = cameraY - viewHeight / 2;
    const bottomY = cameraY + viewHeight / 2;

    // Add padding for smooth loading
    const padding = REGION_SIZE;

    const startRegionX = Math.max(0, Math.floor((leftX - padding) / REGION_SIZE));
    const endRegionX = Math.min(15, Math.floor((rightX + padding) / REGION_SIZE));
    const startRegionY = Math.max(0, Math.floor((topY - padding) / REGION_SIZE));
    const endRegionY = Math.min(15, Math.floor((bottomY + padding) / REGION_SIZE));

    for (let x = startRegionX; x <= endRegionX; x++) {
        for (let y = startRegionY; y <= endRegionY; y++) {
            const regionKey = `${x},${y}`;
            if (!loadedRegions.has(regionKey)) {
                loadRegionPixels(x, y);
                loadedRegions.add(regionKey);
            }
        }
    }

    // Update current region for chat/user management
    const currentRegionX = Math.floor(cameraX / REGION_SIZE);
    const currentRegionY = Math.floor(cameraY / REGION_SIZE);
    updateCurrentRegion(currentRegionX, currentRegionY);
}

let lastRegionX = -1;
let lastRegionY = -1;

function updateCurrentRegion(regionX, regionY) {
    if (regionX !== lastRegionX || regionY !== lastRegionY) {
        lastRegionX = regionX;
        lastRegionY = regionY;

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'user_position',
                region_x: regionX,
                region_y: regionY
            }));
        }
    }
}

function renderCanvas() {
    // Clear canvas with light background
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Calculate viewport
    const viewWidth = canvas.width / zoom;
    const viewHeight = canvas.height / zoom;
    const leftX = cameraX - viewWidth / 2;
    const topY = cameraY - viewHeight / 2;

    // Draw grid for better visual reference at high zoom
    if (zoom > 8) {
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)';
        ctx.lineWidth = 0.5;

        const gridStartX = Math.floor(leftX);
        const gridStartY = Math.floor(topY);
        const gridEndX = Math.ceil(leftX + viewWidth);
        const gridEndY = Math.ceil(topY + viewHeight);

        for (let x = gridStartX; x <= gridEndX; x++) {
            const screenX = (x - leftX) * zoom;
            ctx.beginPath();
            ctx.moveTo(screenX, 0);
            ctx.lineTo(screenX, canvas.height);
            ctx.stroke();
        }

        for (let y = gridStartY; y <= gridEndY; y++) {
            const screenY = (y - topY) * zoom;
            ctx.beginPath();
            ctx.moveTo(0, screenY);
            ctx.lineTo(canvas.width, screenY);
            ctx.stroke();
        }
    }

    // Draw all pixels that are visible
    for (const [pixelKey, pixel] of pixelData.entries()) {
        const [x, y] = pixelKey.split(',').map(Number);

        // Check if pixel is in viewport
        if (x >= leftX && x < leftX + viewWidth &&
            y >= topY && y < topY + viewHeight) {

            const screenX = (x - leftX) * zoom;
            const screenY = (y - topY) * zoom;

            ctx.fillStyle = pixel.color;
            ctx.fillRect(screenX, screenY, zoom, zoom);
        }
    }
}

function connectWebSocket() {
    ws = new WebSocket(`ws://localhost:8000/ws/${userId}`);

    ws.onopen = function () {
        updateStatus('Connected', 'connected');
        pulseConnectionIndicator();
    };

    ws.onmessage = function (event) {
        const data = JSON.parse(event.data);
        handleMessage(data);
        pulseConnectionIndicator(); // Pulse on any important message
    };

    ws.onclose = function () {
        updateStatus('Disconnected', 'error');
        setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = function () {
        updateStatus('Connection Error', 'error');
    };
}

function handleMessage(data) {
    console.log('DEBUG: Received WebSocket message:', data.type, data);
    switch (data.type) {
        case 'region_data':
            loadRegionData(data);
            break;
        case 'pixel_update':
            console.log('DEBUG: Processing pixel_update:', data);
            updatePixel(data.x, data.y, data.color);
            break;
        case 'chat_broadcast':
            addChatMessage(data.user_id, data.message, data.timestamp);
            break;
        case 'rate_limit':
            addSystemMessage(data.message);
            break;
        case 'user_join':
            addSystemMessage(`${data.user_id} joined the region`);
            updateUserCount(data.users_in_region || userCount + 1);
            break;
        case 'user_leave':
            addSystemMessage(`${data.user_id} left the region`);
            updateUserCount(data.users_in_region || Math.max(0, userCount - 1));
            break;
        case 'pong':
            handlePong(data.timestamp);
            break;
        case 'error':
            addSystemMessage(`Error: ${data.message}`);
            break;
    }
}

function loadRegionData(data) {
    // Store pixels from main region data
    Object.entries(data.pixels).forEach(([coords, pixel]) => {
        const [localX, localY] = coords.split(',').map(Number);
        const globalX = data.region_x * REGION_SIZE + localX;
        const globalY = data.region_y * REGION_SIZE + localY;
        const pixelKey = `${globalX},${globalY}`;

        pixelData.set(pixelKey, {
            color: pixel.color,
            timestamp: pixel.timestamp,
            user_id: pixel.user_id
        });
    });

    // Update user count
    updateUserCount(data.users_in_region.length);

    // Load chat history
    const chatMessages = document.getElementById('chatMessages');
    chatMessages.innerHTML = '';
    data.chat_history.forEach(msg => {
        addChatMessage(msg.user_id, msg.message, msg.timestamp, false);
    });

    renderCanvas();
}

async function loadRegionPixels(regionX, regionY) {
    try {
        const response = await fetch(`/api/canvas/${regionX}/${regionY}`);
        const data = await response.json();
        if (data.pixels) {
            // Store pixels in global pixel data
            Object.entries(data.pixels).forEach(([coords, pixel]) => {
                const [localX, localY] = coords.split(',').map(Number);
                const globalX = regionX * REGION_SIZE + localX;
                const globalY = regionY * REGION_SIZE + localY;
                const pixelKey = `${globalX},${globalY}`;

                pixelData.set(pixelKey, {
                    color: pixel.color,
                    timestamp: pixel.timestamp,
                    user_id: pixel.user_id
                });
            });
            renderCanvas();
        }
    } catch (error) {
        console.log(`Failed to load region ${regionX},${regionY}:`, error);
    }
}

function updatePixel(globalX, globalY, color) {
    console.log('DEBUG: Updating pixel at', globalX, globalY, 'with color', color);
    const pixelKey = `${globalX},${globalY}`;
    pixelData.set(pixelKey, {
        color: color,
        timestamp: Date.now() / 1000,
        user_id: 'other'
    });
    console.log('DEBUG: Pixel stored, re-rendering canvas. Total pixels:', pixelData.size);
    renderCanvas();
}

function updateUserCount(count) {
    userCount = count;
    document.getElementById('userCount').textContent = `${count} users`;
}

function setupEventListeners() {
    canvas.addEventListener('click', handleCanvasClick);
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('wheel', handleWheel);
    canvas.addEventListener('mouseleave', () => {
        hidePixelPreview();
        hidePixelInfo();
    });

    document.getElementById('chatInput').addEventListener('keypress', function (e) {
        if (e.key === 'Enter') {
            sendChatMessage();
        }
    });

    // Note: Keyboard navigation removed as requested

    // Start ping interval
    setInterval(updatePing, 5000); // Ping every 5 seconds

    // Animation loop for smooth rendering
    function animate() {
        renderCanvas();
        requestAnimationFrame(animate);
    }
    animate();
}

function handleCanvasClick(event) {
    // Don't place pixel if we were dragging
    if (isDragging) return;

    // Check if we have pixels in bag
    if (pixelBag <= 0) {
        // Visual feedback without chat pollution - flash the pixel bag
        const bagDisplay = document.querySelector('.pixel-bag');
        if (bagDisplay) {
            bagDisplay.style.animation = 'shake 0.5s ease-in-out';
            setTimeout(() => bagDisplay.style.animation = '', 500);
        }
        return;
    }

    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    // Convert screen coordinates to world coordinates
    const viewWidth = canvas.width / zoom;
    const viewHeight = canvas.height / zoom;
    const worldX = Math.floor(cameraX - viewWidth / 2 + mouseX / zoom);
    const worldY = Math.floor(cameraY - viewHeight / 2 + mouseY / zoom);

    // Check bounds
    if (worldX >= 0 && worldX < CANVAS_SIZE && worldY >= 0 && worldY < CANVAS_SIZE) {
        placePixel(worldX, worldY, selectedColor);
    }
}

function handleMouseDown(event) {
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
    isDragging = false;
}

function handleMouseMove(event) {
    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    // Calculate world coordinates for position display and pixel info
    const viewWidth = canvas.width / zoom;
    const viewHeight = canvas.height / zoom;
    mouseWorldX = Math.floor(cameraX - viewWidth / 2 + mouseX / zoom);
    mouseWorldY = Math.floor(cameraY - viewHeight / 2 + mouseY / zoom);

    // Update position display
    updatePositionDisplay();

    // Update pixel preview
    updatePixelPreview(mouseX, mouseY);

    // Show pixel info if hovering over existing pixel
    showPixelInfo(event);

    if (event.buttons === 1) { // Left mouse button pressed
        const deltaX = event.clientX - lastMouseX;
        const deltaY = event.clientY - lastMouseY;

        // Start dragging if moved more than threshold
        if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
            isDragging = true;

            // Move camera (invert direction for natural feel)
            cameraX -= deltaX / zoom;
            cameraY -= deltaY / zoom;

            // Apply bounds checking
            adjustCameraBounds();
            updateVisibleRegions();
        }

        lastMouseX = event.clientX;
        lastMouseY = event.clientY;
    }
}

function updatePositionDisplay() {
    const regionX = Math.floor(mouseWorldX / REGION_SIZE);
    const regionY = Math.floor(mouseWorldY / REGION_SIZE);
    const pixelX = mouseWorldX % REGION_SIZE;
    const pixelY = mouseWorldY % REGION_SIZE;

    document.getElementById('regionPos').textContent = `${regionX},${regionY}`;
    document.getElementById('pixelPos').textContent = `${pixelX},${pixelY}`;
}

function showPixelInfo(event) {
    const tooltip = document.getElementById('pixelInfoTooltip');

    // Check if there's a pixel at this position
    if (mouseWorldX >= 0 && mouseWorldX < CANVAS_SIZE &&
        mouseWorldY >= 0 && mouseWorldY < CANVAS_SIZE) {

        const pixelKey = `${mouseWorldX},${mouseWorldY}`;
        const pixel = pixelData.get(pixelKey);

        if (pixel) {
            // Show tooltip with pixel info
            document.getElementById('pixelUser').textContent = pixel.user_id;
            document.getElementById('pixelTime').textContent = getRelativeTime(pixel.timestamp);

            tooltip.style.left = (event.clientX + 10) + 'px';
            tooltip.style.top = (event.clientY - 40) + 'px';
            tooltip.classList.add('visible');
        } else {
            tooltip.classList.remove('visible');
        }
    } else {
        tooltip.classList.remove('visible');
    }
}

function getRelativeTime(timestamp) {
    const now = Date.now() / 1000;
    const diff = now - timestamp;

    if (diff < 60) return Math.floor(diff) + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
}

function togglePanel(panelId) {
    const panel = document.getElementById(panelId);
    const btn = panel.querySelector('.minimize-btn');

    panel.classList.toggle('minimized');
    btn.textContent = panel.classList.contains('minimized') ? '+' : '−';
}

function pulseConnectionIndicator() {
    const indicator = document.getElementById('connectionIndicator');
    indicator.classList.add('pulse-event');
    setTimeout(() => {
        indicator.classList.remove('pulse-event');
    }, 600);
}

function updatePixelPreview(mouseX, mouseY) {
    const preview = document.getElementById('pixelPreview');

    // Convert screen coordinates to world coordinates
    const viewWidth = canvas.width / zoom;
    const viewHeight = canvas.height / zoom;
    const worldX = Math.floor(cameraX - viewWidth / 2 + mouseX / zoom);
    const worldY = Math.floor(cameraY - viewHeight / 2 + mouseY / zoom);

    // Check if within canvas bounds
    if (worldX >= 0 && worldX < CANVAS_SIZE && worldY >= 0 && worldY < CANVAS_SIZE) {
        // Position preview at pixel grid
        const screenX = (worldX - (cameraX - viewWidth / 2)) * zoom;
        const screenY = (worldY - (cameraY - viewHeight / 2)) * zoom;

        preview.style.left = (canvas.offsetLeft + screenX) + 'px';
        preview.style.top = (canvas.offsetTop + screenY) + 'px';
        preview.style.width = Math.max(zoom, 4) + 'px';
        preview.style.height = Math.max(zoom, 4) + 'px';
        preview.style.backgroundColor = selectedColor;
        preview.classList.add('visible');
    } else {
        preview.classList.remove('visible');
    }
}

function hidePixelPreview() {
    const preview = document.getElementById('pixelPreview');
    preview.classList.remove('visible');
}

function hidePixelInfo() {
    const tooltip = document.getElementById('pixelInfoTooltip');
    tooltip.classList.remove('visible');
}

function updatePing() {
    const now = Date.now();

    if (ws && ws.readyState === WebSocket.OPEN) {
        // Send ping
        lastPingTime = now;
        ws.send(JSON.stringify({
            type: 'ping',
            timestamp: now
        }));
    }
}

function handlePong(timestamp) {
    const now = Date.now();
    ping = now - timestamp;
    document.getElementById('pingDisplay').textContent = ping + 'ms';
}

function handleMouseUp() {
    setTimeout(() => {
        isDragging = false;
    }, 50);
}

function handleWheel(event) {
    event.preventDefault();

    // Get mouse position relative to canvas
    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    // Calculate world position before zoom (point to zoom towards)
    const viewWidth = canvas.width / zoom;
    const viewHeight = canvas.height / zoom;
    const worldX = cameraX - viewWidth / 2 + mouseX / zoom;
    const worldY = cameraY - viewHeight / 2 + mouseY / zoom;

    // Update zoom
    const zoomFactor = event.deltaY > 0 ? 0.8 : 1.25;
    const newZoom = zoom * zoomFactor;

    // Calculate bounds for minimum zoom
    const minZoomX = canvas.width / CANVAS_SIZE;
    const minZoomY = canvas.height / CANVAS_SIZE;
    const minZoom = Math.max(minZoomX, minZoomY) * 1.1; // Add small margin

    // Clamp zoom
    zoom = Math.max(minZoom, Math.min(50, newZoom));

    // Calculate new view dimensions
    const newViewWidth = canvas.width / zoom;
    const newViewHeight = canvas.height / zoom;

    // Adjust camera to keep mouse position fixed in world space
    cameraX = worldX - (mouseX / zoom) + newViewWidth / 2;
    cameraY = worldY - (mouseY / zoom) + newViewHeight / 2;

    // Apply bounds checking
    adjustCameraBounds();
    updateVisibleRegions();
}

function placePixel(x, y, color) {
    // Check if we have pixels in bag
    if (pixelBag <= 0) {
        // Visual feedback without chat pollution - flash the pixel bag
        const bagDisplay = document.querySelector('.pixel-bag');
        if (bagDisplay) {
            bagDisplay.style.animation = 'shake 0.5s ease-in-out';
            setTimeout(() => bagDisplay.style.animation = '', 500);
        }
        return;
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'pixel_place',
            x: x,
            y: y,
            color: color
        }));

        // Consume a pixel from bag
        pixelBag--;
        updatePixelBagDisplay();

        // Removed: addSystemMessage to avoid chat pollution
    }
}

function sendChatMessage() {
    const input = document.getElementById('chatInput');
    const message = input.value.trim();

    if (!message) return;

    // Check rate limiting
    const now = Date.now();
    if (now - lastChatTime < CHAT_COOLDOWN) {
        const remainingTime = Math.ceil((CHAT_COOLDOWN - (now - lastChatTime)) / 1000);
        addSystemMessage(`Please wait ${remainingTime} seconds before sending another message.`);
        return;
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'chat_message',
            message: message
        }));
        input.value = '';
        lastChatTime = now;
    }
}

function addChatMessage(userId, message, timestamp, scroll = true) {
    const chatMessages = document.getElementById('chatMessages');
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message chat';

    const time = new Date(timestamp * 1000).toLocaleTimeString();
    messageDiv.innerHTML = `
        <span class="timestamp">[${time}]</span>
        <span class="username">${userId}:</span>
        ${escapeHtml(message)}
    `;

    chatMessages.appendChild(messageDiv);

    if (scroll) {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
}

function addSystemMessage(message) {
    const chatMessages = document.getElementById('chatMessages');
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message system';
    messageDiv.textContent = message;

    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function updateStatus(message, statusType = 'connecting') {
    const indicator = document.getElementById('connectionIndicator');

    // Remove all status classes
    indicator.className = 'status-indicator';

    // Add appropriate status class
    switch (statusType) {
        case 'connected':
            indicator.classList.add('status-connected');
            break;
        case 'error':
            indicator.classList.add('status-error');
            break;
        default:
            indicator.classList.add('status-connecting');
    }

    // Could add a status text somewhere if needed
    console.log('Connection status:', message);
}

function escapeHtml(unsafe) {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Initialize the application when DOM is ready
init();
