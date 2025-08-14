// Global variables
let ws = null;
let canvas = null; // Will be initialized when DOM is ready
let ctx = null; // Will be initialized when DOM is ready
let selectedColor = '#FF0000';
let userId = 'user_' + Math.random().toString(36).substr(2, 9);

// Authentication
let authToken = null;
let currentUser = null;
let isAuthenticated = false;
let currentUsername = null;

// Camera and viewport
let zoom = 1;
let cameraX = 4096; // Will be updated from config 
let cameraY = 4096;
let isDragging = false;
let wasDragging = false; // Track if we just finished dragging
let lastDragEndTime = 0; // Timestamp of last drag end
let mouseDownTime = 0; // Track when mouse was pressed
let totalDragDistance = 0; // Track total distance dragged
let dragStartX = 0; // Where drag started (world coordinates)
let dragStartY = 0;
let dragStartCameraX = 0; // Camera position when drag started
let dragStartCameraY = 0;
let lastMouseX = 0;
let lastMouseY = 0;

// Pixel bag system - will be loaded from server config
let pixelBag = 0;
let maxPixelBag = 0;
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

// Region loading throttling
let lastRegionUpdateTime = 0;
const REGION_UPDATE_THROTTLE = 100; // milliseconds between region updates

// Bulk placement system
let isBulkMode = false;
let bulkPlacing = false;
let lastBulkPixelTime = 0;
const BULK_PLACEMENT_DELAY = 10; // milliseconds between bulk pixels
let bulkPlacementPath = new Set(); // Track pixels already placed in current bulk session
let bulkPreviewPixels = new Map(); // Store preview pixels {x,y} -> color

// Configuration - will be loaded from server
let CONFIG = {
    CANVAS_SIZE: 8192,
    REGION_SIZE: 512,
    PIXEL_REFILL_RATE: 3.0,
    MAX_PIXEL_BAG: 10,
    INITIAL_PIXEL_BAG: 3,
    authentication_required: true
};

// Color palette - Basic 16 colors
const colors = [
    '#FF0000', '#00FF00', '#0000FF', '#FFFF00',
    '#FF00FF', '#00FFFF', '#FFFFFF', '#000000',
    '#800000', '#008000', '#000080', '#808000',
    '#800080', '#008080', '#C0C0C0', '#808080'
];

// Load configuration from server
async function loadConfig() {
    try {
        const response = await fetch('/api/config');
        const config = await response.json();
        
        CONFIG.CANVAS_SIZE = config.canvas_size;
        CONFIG.REGION_SIZE = config.region_size;
        CONFIG.PIXEL_REFILL_RATE = config.pixel_refill_rate;
        CONFIG.MAX_PIXEL_BAG = config.max_pixel_bag;
        CONFIG.INITIAL_PIXEL_BAG = config.initial_pixel_bag;
        
        // Update global variables
        maxPixelBag = CONFIG.MAX_PIXEL_BAG;
        pixelBag = CONFIG.INITIAL_PIXEL_BAG;
        cameraX = CONFIG.CANVAS_SIZE / 2;
        cameraY = CONFIG.CANVAS_SIZE / 2;
        
        console.log('Configuration loaded:', CONFIG);
        return true;
    } catch (error) {
        console.error('Failed to load configuration, using defaults:', error);
        // Ensure CONFIG has default values even if API fails
        maxPixelBag = CONFIG.MAX_PIXEL_BAG;
        pixelBag = CONFIG.INITIAL_PIXEL_BAG;
        cameraX = CONFIG.CANVAS_SIZE / 2;
        cameraY = CONFIG.CANVAS_SIZE / 2;
        return false;
    }
}

// Initialize application
async function init() {
    try {
        console.log('🚀 Starting initialization...');
        
        // Wait for DOM to be ready
        if (document.readyState === 'loading') {
            console.log('⏳ DOM not ready, adding listener...');
            document.addEventListener('DOMContentLoaded', init);
            return;
        }

        console.log('✅ DOM ready');

        // Initialize canvas and context
        canvas = document.getElementById('pixelCanvas');
        if (!canvas) {
            console.error('❌ Canvas element not found!');
            return;
        }
        ctx = canvas.getContext('2d');
        if (!ctx) {
            console.error('❌ Failed to get canvas context!');
            return;
        }
        console.log('✅ Canvas initialized');

        // Load configuration from server first
        console.log('📡 Loading configuration...');
        const configLoaded = await loadConfig();
        console.log('✅ Configuration loaded:', configLoaded);

        console.log('🎨 Setting up canvas...');
        setupCanvas();
        
        console.log('🎨 Setting up color palette...');
        setupColorPalette();
        
        console.log('🎧 Setting up event listeners...');
        setupEventListeners();
        
        console.log('🎒 Starting pixel bag system...');
        startPixelBagSystem();

        // Set initial zoom to be much smaller for better overview
        console.log('📏 Canvas dimensions:', canvas.width, 'x', canvas.height);
        console.log('📏 CONFIG.CANVAS_SIZE:', CONFIG.CANVAS_SIZE);
        
        const zoomX = canvas.width / CONFIG.CANVAS_SIZE;
        const zoomY = canvas.height / CONFIG.CANVAS_SIZE;
        zoom = Math.max(zoomX, zoomY) * 50;

        console.log('📷 Zoom calculation - zoomX:', zoomX, 'zoomY:', zoomY, 'final zoom:', zoom);
        
        // Ensure zoom is never 0 or invalid
        if (zoom <= 0 || !isFinite(zoom)) {
            console.warn('⚠️ Invalid zoom calculated, using default value');
            zoom = 0.1; // Default fallback zoom
        }
        
        console.log('📷 Camera setup - zoom:', zoom, 'camera:', cameraX, cameraY);

        console.log('🔧 Adjusting camera bounds...');
        adjustCameraBounds();
        
        console.log('🗺️ Updating visible regions...');
        updateVisibleRegions();

        // FALLBACK 3: Periodic check for missing visible regions
        setInterval(() => {
            checkAndLoadMissingVisibleRegions();
        }, 2000); // Check every 2 seconds

        // Initialize UI first
        console.log('🖥️ Updating UI...');
        updateStatus('Connecting...', 'connecting');
        updatePixelBagDisplay();
        
        console.log('🎉 Basic initialization complete! Checking authentication...');
        
        // Check authentication status via API before proceeding
        await checkAuthenticationStatus();
        
        // Start periodic authentication check (every 5 minutes)
        setInterval(async () => {
            try {
                const response = await fetch('/auth/check', {
                    credentials: 'include'
                });
                
                if (!response.ok || !isAuthenticated) {
                    // Session expired or invalid, trigger re-authentication
                    console.log('Session expired, redirecting to login...');
                    logout();
                }
            } catch (error) {
                console.error('Periodic auth check failed:', error);
            }
        }, 5 * 60 * 1000); // 5 minutes
        
    } catch (error) {
        console.error('💥 Error during initialization:', error);
        console.error('Stack trace:', error.stack);
    }
}

function setupCanvas() {
    if (!canvas || !ctx) {
        console.error('Canvas or context not available in setupCanvas');
        return;
    }
    
    // Set canvas to full viewport size (floating palette doesn't take space)
    const container = document.querySelector('.canvas-container');
    const rect = container.getBoundingClientRect();

    // Ensure minimum canvas size if container is not visible
    const minWidth = 800;
    const minHeight = 600;
    
    canvas.width = Math.max(rect.width, minWidth);
    canvas.height = Math.max(rect.height, minHeight);
    
    console.log('🎨 Canvas setup - container rect:', rect.width, 'x', rect.height);
    console.log('🎨 Canvas final size:', canvas.width, 'x', canvas.height);

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
        canvas.width = Math.max(newRect.width, minWidth);
        canvas.height = Math.max(newRect.height, minHeight);

        // Maintain zoom level but adjust camera bounds
        adjustCameraBounds();
        renderCanvas();
    });
}

function adjustCameraBounds() {
    // Ensure zoom is valid before calculations
    if (zoom <= 0 || !isFinite(zoom)) {
        console.warn('⚠️ Invalid zoom in adjustCameraBounds, using default');
        zoom = 0.1;
    }
    
    // Calculate max zoom to prevent seeing beyond canvas edges
    const maxZoomX = canvas.width / CONFIG.CANVAS_SIZE;
    const maxZoomY = canvas.height / CONFIG.CANVAS_SIZE;
    const maxZoom = Math.max(maxZoomX, maxZoomY);

    // Limit minimum zoom to prevent seeing beyond edges
    zoom = Math.max(maxZoom, zoom);

    // Recalculate view dimensions with corrected zoom
    const newViewWidth = canvas.width / zoom;
    const newViewHeight = canvas.height / zoom;

    // Clamp camera to ensure canvas always fills viewport
    cameraX = Math.max(newViewWidth / 2, Math.min(CONFIG.CANVAS_SIZE - newViewWidth / 2, cameraX));
    cameraY = Math.max(newViewHeight / 2, Math.min(CONFIG.CANVAS_SIZE - newViewHeight / 2, cameraY));
    
    // Update visible regions after camera changes
    updateVisibleRegions();
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
    // Start with configured initial pixels
    pixelBag = CONFIG.INITIAL_PIXEL_BAG;
    updatePixelBagDisplay();

    // Clear any existing interval
    if (bagRefillInterval) {
        clearInterval(bagRefillInterval);
    }

    // Refill bag based on configured rate (convert seconds to milliseconds)
    bagRefillInterval = setInterval(() => {
        if (pixelBag < maxPixelBag) {
            pixelBag++;
            updatePixelBagDisplay();
        }
    }, CONFIG.PIXEL_REFILL_RATE * 1000);
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
    // Throttle region updates to prevent excessive loading during fast movement
    const now = Date.now();
    if (now - lastRegionUpdateTime < REGION_UPDATE_THROTTLE) {
        return; // Skip this update, too soon since last one
    }
    lastRegionUpdateTime = now;

    // Calculate view dimensions based on current zoom
    const viewWidth = canvas.width / zoom;
    const viewHeight = canvas.height / zoom;

    // Calculate the viewport bounds in world coordinates
    const leftX = cameraX - viewWidth / 2;
    const rightX = cameraX + viewWidth / 2;
    const topY = cameraY - viewHeight / 2;
    const bottomY = cameraY + viewHeight / 2;

    // Dynamic padding based on zoom level - more zoom = less padding needed
    // At high zoom (zoomed in), we need less padding
    // At low zoom (zoomed out), we need more padding to handle rapid movement
    const basePadding = CONFIG.REGION_SIZE * 2; // Base padding
    const zoomFactor = Math.max(0.5, Math.min(2, 1 / zoom * 10)); // Scale factor based on zoom
    const dynamicPadding = basePadding * zoomFactor;

    console.log(`🔍 Zoom: ${zoom.toFixed(3)}, View: ${viewWidth.toFixed(0)}x${viewHeight.toFixed(0)}, Padding: ${dynamicPadding.toFixed(0)}`);

    // Calculate region bounds with dynamic padding
    const startRegionX = Math.max(0, Math.floor((leftX - dynamicPadding) / CONFIG.REGION_SIZE));
    const endRegionX = Math.min(CONFIG.CANVAS_SIZE / CONFIG.REGION_SIZE - 1, Math.floor((rightX + dynamicPadding) / CONFIG.REGION_SIZE));
    const startRegionY = Math.max(0, Math.floor((topY - dynamicPadding) / CONFIG.REGION_SIZE));
    const endRegionY = Math.min(CONFIG.CANVAS_SIZE / CONFIG.REGION_SIZE - 1, Math.floor((bottomY + dynamicPadding) / CONFIG.REGION_SIZE));

    // Calculate how many regions we're trying to load
    const regionsToLoad = (endRegionX - startRegionX + 1) * (endRegionY - startRegionY + 1);
    console.log(`📋 Loading regions ${startRegionX}-${endRegionX} x ${startRegionY}-${endRegionY} (${regionsToLoad} total)`);

    // Load all visible regions
    let newRegionsLoaded = 0;
    for (let x = startRegionX; x <= endRegionX; x++) {
        for (let y = startRegionY; y <= endRegionY; y++) {
            const regionKey = `${x},${y}`;
            if (!loadedRegions.has(regionKey)) {
                loadRegionPixels(x, y);
                loadedRegions.add(regionKey);
                newRegionsLoaded++;
            }
        }
    }

    if (newRegionsLoaded > 0) {
        console.log(`🆕 Loaded ${newRegionsLoaded} new regions`);
    }

    // Update current region for chat/user management and broadcast all visible regions
    const currentRegionX = Math.floor(cameraX / CONFIG.REGION_SIZE);
    const currentRegionY = Math.floor(cameraY / CONFIG.REGION_SIZE);
    updateCurrentRegion(currentRegionX, currentRegionY);
    
    // Also send all visible regions to backend for multi-region pixel broadcasting
    updateVisibleRegionsBackend();
}

let lastRegionX = -1;
let lastRegionY = -1;
let lastVisibleRegionsHash = '';

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

function updateVisibleRegionsBackend() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }
    
    // Calculate view dimensions based on current zoom
    const viewWidth = canvas.width / zoom;
    const viewHeight = canvas.height / zoom;

    // Calculate the viewport bounds in world coordinates
    const leftX = cameraX - viewWidth / 2;
    const rightX = cameraX + viewWidth / 2;
    const topY = cameraY - viewHeight / 2;
    const bottomY = cameraY + viewHeight / 2;

    // Calculate region bounds (same logic as updateVisibleRegions but for backend)
    const startRegionX = Math.max(0, Math.floor(leftX / CONFIG.REGION_SIZE));
    const endRegionX = Math.min(CONFIG.CANVAS_SIZE / CONFIG.REGION_SIZE - 1, Math.floor(rightX / CONFIG.REGION_SIZE));
    const startRegionY = Math.max(0, Math.floor(topY / CONFIG.REGION_SIZE));
    const endRegionY = Math.min(CONFIG.CANVAS_SIZE / CONFIG.REGION_SIZE - 1, Math.floor(bottomY / CONFIG.REGION_SIZE));

    // Collect all visible regions
    const visibleRegions = [];
    for (let x = startRegionX; x <= endRegionX; x++) {
        for (let y = startRegionY; y <= endRegionY; y++) {
            visibleRegions.push({ x: x, y: y });
        }
    }
    
    // Create a hash to avoid sending the same data repeatedly
    const regionsHash = visibleRegions.map(r => `${r.x},${r.y}`).sort().join('|');
    
    if (regionsHash !== lastVisibleRegionsHash) {
        lastVisibleRegionsHash = regionsHash;
        
        console.log(`📡 Sending ${visibleRegions.length} visible regions to backend:`, visibleRegions);
        
        ws.send(JSON.stringify({
            type: 'viewport_regions',
            regions: visibleRegions
        }));
    }
}

// FALLBACK FUNCTIONS for robust region loading

function ensureRegionLoadedForPosition(worldX, worldY) {
    // Check bounds first
    if (worldX < 0 || worldX >= CONFIG.CANVAS_SIZE || worldY < 0 || worldY >= CONFIG.CANVAS_SIZE) {
        return;
    }
    
    const regionX = Math.floor(worldX / CONFIG.REGION_SIZE);
    const regionY = Math.floor(worldY / CONFIG.REGION_SIZE);
    const regionKey = `${regionX},${regionY}`;
    
    if (!loadedRegions.has(regionKey)) {
        console.log(`🎯 FALLBACK: Loading region ${regionKey} for hover at ${worldX},${worldY}`);
        loadRegionPixels(regionX, regionY);
        loadedRegions.add(regionKey);
    }
}

function forceLoadAllVisibleRegions() {
    // FALLBACK 2: Aggressive check of what's actually visible on screen
    console.log('🔄 FORCE LOADING all visible regions...');
    
    // Calculate exact screen bounds
    const viewWidth = canvas.width / zoom;
    const viewHeight = canvas.height / zoom;
    const leftX = cameraX - viewWidth / 2;
    const rightX = cameraX + viewWidth / 2;
    const topY = cameraY - viewHeight / 2;
    const bottomY = cameraY + viewHeight / 2;
    
    console.log(`📐 Screen bounds: ${leftX.toFixed(0)},${topY.toFixed(0)} to ${rightX.toFixed(0)},${bottomY.toFixed(0)}`);
    
    // Add generous padding to ensure edge regions are loaded
    const generousPadding = CONFIG.REGION_SIZE * 3; // Very generous padding
    
    const startRegionX = Math.max(0, Math.floor((leftX - generousPadding) / CONFIG.REGION_SIZE));
    const endRegionX = Math.min(CONFIG.CANVAS_SIZE / CONFIG.REGION_SIZE - 1, Math.floor((rightX + generousPadding) / CONFIG.REGION_SIZE));
    const startRegionY = Math.max(0, Math.floor((topY - generousPadding) / CONFIG.REGION_SIZE));
    const endRegionY = Math.min(CONFIG.CANVAS_SIZE / CONFIG.REGION_SIZE - 1, Math.floor((bottomY + generousPadding) / CONFIG.REGION_SIZE));
    
    console.log(`🎯 Force loading regions ${startRegionX}-${endRegionX} x ${startRegionY}-${endRegionY}`);
    
    let forcedLoads = 0;
    for (let x = startRegionX; x <= endRegionX; x++) {
        for (let y = startRegionY; y <= endRegionY; y++) {
            const regionKey = `${x},${y}`;
            if (!loadedRegions.has(regionKey)) {
                console.log(`⚡ FORCE: Loading region ${regionKey}`);
                loadRegionPixels(x, y);
                loadedRegions.add(regionKey);
                forcedLoads++;
            }
        }
    }
    
    console.log(`⚡ Force loaded ${forcedLoads} regions`);
    return forcedLoads;
}

function checkAndLoadMissingVisibleRegions() {
    // FALLBACK 3: Periodic check for regions that should be visible but aren't loaded
    const viewWidth = canvas.width / zoom;
    const viewHeight = canvas.height / zoom;
    const leftX = cameraX - viewWidth / 2;
    const rightX = cameraX + viewWidth / 2;
    const topY = cameraY - viewHeight / 2;
    const bottomY = cameraY + viewHeight / 2;
    
    // Check exact visible region bounds (no padding)
    const startRegionX = Math.max(0, Math.floor(leftX / CONFIG.REGION_SIZE));
    const endRegionX = Math.min(CONFIG.CANVAS_SIZE / CONFIG.REGION_SIZE - 1, Math.floor(rightX / CONFIG.REGION_SIZE));
    const startRegionY = Math.max(0, Math.floor(topY / CONFIG.REGION_SIZE));
    const endRegionY = Math.min(CONFIG.CANVAS_SIZE / CONFIG.REGION_SIZE - 1, Math.floor(bottomY / CONFIG.REGION_SIZE));
    
    let missingRegions = [];
    for (let x = startRegionX; x <= endRegionX; x++) {
        for (let y = startRegionY; y <= endRegionY; y++) {
            const regionKey = `${x},${y}`;
            if (!loadedRegions.has(regionKey)) {
                missingRegions.push({x, y, key: regionKey});
            }
        }
    }
    
    if (missingRegions.length > 0) {
        console.log(`🔍 PERIODIC CHECK: Found ${missingRegions.length} missing visible regions:`, missingRegions.map(r => r.key));
        missingRegions.forEach(region => {
            console.log(`🔄 Loading missing region ${region.key}`);
            loadRegionPixels(region.x, region.y);
            loadedRegions.add(region.key);
        });
    }
}

// Debug function (available globally)
window.debugRegions = function() {
    console.log('=== REGION DEBUG INFO ===');
    console.log('Current zoom:', zoom);
    console.log('Camera position:', cameraX, cameraY);
    console.log('Loaded regions:', Array.from(loadedRegions).sort());
    
    const viewWidth = canvas.width / zoom;
    const viewHeight = canvas.height / zoom;
    const leftX = cameraX - viewWidth / 2;
    const rightX = cameraX + viewWidth / 2;
    const topY = cameraY - viewHeight / 2;
    const bottomY = cameraY + viewHeight / 2;
    
    console.log(`View bounds: ${leftX.toFixed(0)},${topY.toFixed(0)} to ${rightX.toFixed(0)},${bottomY.toFixed(0)}`);
    
    const startRegionX = Math.max(0, Math.floor(leftX / CONFIG.REGION_SIZE));
    const endRegionX = Math.min(CONFIG.CANVAS_SIZE / CONFIG.REGION_SIZE - 1, Math.floor(rightX / CONFIG.REGION_SIZE));
    const startRegionY = Math.max(0, Math.floor(topY / CONFIG.REGION_SIZE));
    const endRegionY = Math.min(CONFIG.CANVAS_SIZE / CONFIG.REGION_SIZE - 1, Math.floor(bottomY / CONFIG.REGION_SIZE));
    
    console.log(`Should have regions: ${startRegionX}-${endRegionX} x ${startRegionY}-${endRegionY}`);
    
    let missing = [];
    for (let x = startRegionX; x <= endRegionX; x++) {
        for (let y = startRegionY; y <= endRegionY; y++) {
            const regionKey = `${x},${y}`;
            if (!loadedRegions.has(regionKey)) {
                missing.push(regionKey);
            }
        }
    }
    
    if (missing.length > 0) {
        console.log('❌ MISSING visible regions:', missing);
        console.log('🔧 Run forceLoadAllVisibleRegions() to fix');
    } else {
        console.log('✅ All visible regions are loaded');
    }
    console.log('=========================');
};

// Make force load function available globally too
window.forceLoadAllVisibleRegions = forceLoadAllVisibleRegions;

// Test functions for bulk mode
window.testBulkMode = function() {
    console.log('🧪 Testing bulk mode activation...');
    isBulkMode = true;
    bulkPlacementPath.clear();
    console.log('🚀 BULK MODE ACTIVATED (manually)');
    
    // Visual feedback
    document.body.style.cursor = 'crosshair';
    const bulkIndicator = document.createElement('div');
    bulkIndicator.id = 'bulkIndicator';
    bulkIndicator.innerHTML = '🚀 BULK MODE - MANUAL TEST';
    bulkIndicator.style.cssText = `
        position: fixed;
        top: 10px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(255, 0, 0, 0.8);
        color: white;
        padding: 8px 16px;
        border-radius: 20px;
        font-weight: bold;
        font-size: 14px;
        z-index: 1000;
        pointer-events: none;
        box-shadow: 0 2px 10px rgba(0,0,0,0.3);
    `;
    document.body.appendChild(bulkIndicator);
};

window.testKeyListeners = function() {
    console.log('🧪 Testing key listeners...');
    document.addEventListener('keydown', function(e) {
        console.log('🔍 DEBUG: Keydown detected:', e.code, e.key);
    });
    document.addEventListener('keyup', function(e) {
        console.log('🔍 DEBUG: Keyup detected:', e.code, e.key);
    });
    console.log('✅ Debug key listeners added');
};

function renderCanvas() {
    if (!canvas || !ctx) {
        return; // Don't render if canvas is not available
    }
    
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

    // Draw preview pixels (bulk mode)
    if (isBulkMode && bulkPreviewPixels.size > 0) {
        for (const [pixelKey, color] of bulkPreviewPixels.entries()) {
            const [x, y] = pixelKey.split(',').map(Number);

            // Check if preview pixel is in viewport
            if (x >= leftX && x < leftX + viewWidth &&
                y >= topY && y < topY + viewHeight) {

                const screenX = (x - leftX) * zoom;
                const screenY = (y - topY) * zoom;

                // Calculate pulse effect based on time
                const time = Date.now() * 0.003;
                const pulse = 0.1 + 0.1 * Math.sin(time + x * 0.1 + y * 0.1);
                
                // Draw preview pixel with animated effect
                ctx.fillStyle = color;
                ctx.globalAlpha = 0.6 + pulse; // Pulsing transparency
                ctx.fillRect(screenX, screenY, zoom, zoom);
                
                // Add animated glowing border effect
                ctx.globalAlpha = 0.8 + pulse * 0.5;
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = Math.max(1, zoom * 0.1) + pulse;
                ctx.strokeRect(screenX - pulse, screenY - pulse, zoom + pulse * 2, zoom + pulse * 2);
                
                // Add inner highlight with shimmer
                ctx.globalAlpha = 0.9;
                ctx.strokeStyle = color;
                ctx.lineWidth = Math.max(0.5, zoom * 0.05);
                ctx.strokeRect(screenX + 1, screenY + 1, zoom - 2, zoom - 2);
                
                // Add sparkle effect for high zoom
                if (zoom > 4) {
                    const sparkle = Math.sin(time * 2 + x * 0.5 + y * 0.5);
                    if (sparkle > 0.7) {
                        ctx.fillStyle = '#ffffff';
                        ctx.globalAlpha = sparkle - 0.5;
                        const sparkleSize = 2;
                        ctx.fillRect(
                            screenX + zoom/2 - sparkleSize/2, 
                            screenY + zoom/2 - sparkleSize/2, 
                            sparkleSize, 
                            sparkleSize
                        );
                    }
                }
            }
        }
        ctx.globalAlpha = 1; // Reset alpha
    }
}

async function connectWebSocket() {
    console.log('🔌 Attempting WebSocket connection...');
    console.log('🔐 isAuthenticated:', isAuthenticated);
    console.log('🔑 authToken:', authToken ? 'present' : 'missing');
    console.log('👤 currentUser:', currentUser);
    
    if (!isAuthenticated || !authToken) {
        console.error('Cannot connect WebSocket: not authenticated');
        return;
    }

    ws = new WebSocket(`ws://localhost:8000/ws/${currentUser.username}`);

    ws.onopen = function () {
        console.log('WebSocket opened, sending authentication...');
        // Send authentication message first
        ws.send(JSON.stringify({
            type: 'auth',
            token: authToken
        }));
    };

    ws.onmessage = function (event) {
        const data = JSON.parse(event.data);
        handleMessage(data);
        pulseConnectionIndicator(); // Pulse on any important message
    };

    ws.onclose = function () {
        updateStatus('Disconnected', 'error');
        // Only auto-reconnect if still authenticated
        if (isAuthenticated) {
            setTimeout(connectWebSocket, 3000);
        }
    };

    ws.onerror = function () {
        updateStatus('Connection Error', 'error');
    };
}

function handleMessage(data) {
    console.log('DEBUG: Received WebSocket message:', data.type, data);
    switch (data.type) {
        case 'auth_success':
            console.log('WebSocket authentication successful:', data.user);
            updateStatus('Connected', 'connected');
            pulseConnectionIndicator();
            // Now that we're authenticated, we can start using the canvas
            break;
        case 'auth_error':
            console.error('WebSocket authentication failed:', data.message);
            updateStatus('Auth Failed', 'error');
            // Force logout on auth failure
            logout();
            break;
        case 'region_data':
            loadRegionData(data);
            break;
        case 'pixel_update':
            console.log('DEBUG: Processing pixel_update:', data);
            updatePixel(data.x, data.y, data.color);
            
            // Track pixel placement for achievements (only if it's the current user)
            if (data.user_id === currentUsername) {
                pixelsPlacedCount++;
            }
            break;
        case 'pixel_bag_update':
            console.log('📦 Received pixel bag update:', data);
            pixelBag = data.pixel_bag_size;
            maxPixelBag = data.max_pixel_bag_size;
            updatePixelBagDisplay();
            break;
        case 'bulk_complete':
            console.log(`🚀 Bulk placement complete: ${data.placed}/${data.requested} pixels placed (available at start: ${data.available_at_start})`);
            
            // Track bulk placement for achievements
            if (data.placed > 0) {
                bulkPlacementsCount++;
                pixelsPlacedCount += data.placed; // Add the placed pixels to total count
            }
            
            // Create success animation with detailed stats
            createBulkSuccessAnimation(data.placed, data.requested);
            
            // Update bulk indicator with final results
            if (bulkIndicator && isBulkMode) {
                if (data.placed < data.requested) {
                    bulkIndicator.innerHTML = `
                        <span style="color: #ffa726;">⚠️ Placed ${data.placed}/${data.requested} pixels • Bag limit reached</span>
                    `;
                } else {
                    bulkIndicator.innerHTML = `
                        <span style="color: #4caf50;">✅ Placed all ${data.placed} pixels!</span>
                    `;
                }
            }
            
            if (data.placed < data.requested) {
                addSystemMessage(`⚠️ Bulk placement: ${data.placed}/${data.requested} pixels placed (pixel bag limit)`);
            } else {
                addSystemMessage(`✅ Successfully placed ${data.placed} pixels`);
            }
            
            // Clear preview pixels after showing results
            setTimeout(() => {
                bulkPreviewPixels.clear();
                renderCanvas();
            }, 1500);
            break;
        case 'chat_broadcast':
            addChatMessage(data.user_id, data.message, data.timestamp, data.user_data);
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
        const globalX = data.region_x * CONFIG.REGION_SIZE + localX;
        const globalY = data.region_y * CONFIG.REGION_SIZE + localY;
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
                const globalX = regionX * CONFIG.REGION_SIZE + localX;
                const globalY = regionY * CONFIG.REGION_SIZE + localY;
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
    
    // Calculate which region this pixel belongs to
    const regionX = Math.floor(globalX / CONFIG.REGION_SIZE);
    const regionY = Math.floor(globalY / CONFIG.REGION_SIZE);
    const regionKey = `${regionX},${regionY}`;
    
    // Ensure this region is loaded so the pixel will be visible
    if (!loadedRegions.has(regionKey)) {
        console.log(`🔄 Loading region ${regionKey} to display new pixel`);
        loadRegionPixels(regionX, regionY);
        loadedRegions.add(regionKey);
    }
    
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
    if (!canvas) {
        console.error('❌ Canvas not available in setupEventListeners');
        return;
    }
    
    console.log('🎧 Setting up event listeners...');
    
    // Use capture phase for click to intercept before other handlers
    canvas.addEventListener('click', handleCanvasClick, true);
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('wheel', handleWheel);
    canvas.addEventListener('mouseleave', () => {
        hidePixelPreview();
        hidePixelInfo();
    });

    console.log('✅ Canvas event listeners attached');

    document.getElementById('chatInput').addEventListener('keypress', function (e) {
        if (e.key === 'Enter') {
            sendChatMessage();
        }
    });

    // Bulk placement with Space key
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    console.log('✅ Keyboard event listeners attached (keydown, keyup)');

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
    console.log('🎯 Canvas click event fired');

    const clickTime = Date.now();
    const timeSinceMouseDown = clickTime - mouseDownTime;
    const timeSinceLastDrag = clickTime - lastDragEndTime;
    
    // Multiple conditions to detect if this was a drag:
    // 1. Currently dragging
    // 2. Just finished dragging
    // 3. Recent drag end (within 100ms)
    // 4. Too much total movement (>5px)
    // 5. Too long press (>200ms typically indicates drag intent)
    
    if (isDragging || 
        wasDragging || 
        timeSinceLastDrag < 100 || 
        totalDragDistance > 5 ||
        timeSinceMouseDown > 200) {
        
        console.log(`🚫 Ignoring click - drag detected (distance: ${totalDragDistance}px, time: ${timeSinceMouseDown}ms)`);
        wasDragging = false;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
    }

    console.log(`✅ Valid click detected (distance: ${totalDragDistance}px, time: ${timeSinceMouseDown}ms)`);

    // Check if we have pixels in bag (need at least 1 pixel)
    if (pixelBag < 1) {
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
    if (worldX >= 0 && worldX < CONFIG.CANVAS_SIZE && worldY >= 0 && worldY < CONFIG.CANVAS_SIZE) {
        // FALLBACK 1: Ensure the region is loaded before placing pixel
        ensureRegionLoadedForPosition(worldX, worldY);
        
        // FALLBACK 2: Force load all visible regions if region wasn't loaded
        const regionX = Math.floor(worldX / CONFIG.REGION_SIZE);
        const regionY = Math.floor(worldY / CONFIG.REGION_SIZE);
        const regionKey = `${regionX},${regionY}`;
        
        if (!loadedRegions.has(regionKey)) {
            console.log(`⚠️ Region ${regionKey} STILL not loaded after fallback 1, forcing aggressive load...`);
            forceLoadAllVisibleRegions();
            
            // Ensure this specific region is loaded
            if (!loadedRegions.has(regionKey)) {
                console.log(`� EMERGENCY: Force loading region ${regionKey} for pixel placement`);
                loadRegionPixels(regionX, regionY);
                loadedRegions.add(regionKey);
            }
        }
        
        // Wait a tiny bit for region to load, then place pixel
        setTimeout(() => {
            if (isBulkMode) {
                placePixelBulk(worldX, worldY, selectedColor);
            } else {
                placePixel(worldX, worldY, selectedColor);
            }
        }, 50); // Small delay to ensure region is loaded
    }
}

function handleMouseDown(event) {
    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    
    // Convert to world coordinates - this is our "anchor point"
    const viewWidth = canvas.width / zoom;
    const viewHeight = canvas.height / zoom;
    dragStartX = cameraX - viewWidth / 2 + mouseX / zoom;
    dragStartY = cameraY - viewHeight / 2 + mouseY / zoom;
    
    // Store initial camera position
    dragStartCameraX = cameraX;
    dragStartCameraY = cameraY;
    
    // Store mouse position for tracking
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
    
    // Reset drag states
    isDragging = false; // Will become true on first movement
    wasDragging = false;
    mouseDownTime = Date.now();
    totalDragDistance = 0;
}

function handleMouseMove(event) {
    if (!canvas) return; // Safety check
    
    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    // Calculate world coordinates for position display and pixel info
    const viewWidth = canvas.width / zoom;
    const viewHeight = canvas.height / zoom;
    mouseWorldX = Math.floor(cameraX - viewWidth / 2 + mouseX / zoom);
    mouseWorldY = Math.floor(cameraY - viewHeight / 2 + mouseY / zoom);

    // FALLBACK 1: Load region under mouse cursor (hover-based loading)
    ensureRegionLoadedForPosition(mouseWorldX, mouseWorldY);

    // Debug: uncomment to see if mouse move is working
    // console.log('Mouse:', mouseX, mouseY, 'World:', mouseWorldX, mouseWorldY);

    // Update position display
    updatePositionDisplay();

    // Update pixel preview
    updatePixelPreview(mouseX, mouseY);

    // Show pixel info if hovering over existing pixel
    showPixelInfo(event);

    if (event.buttons === 1) { // Left mouse button pressed
        const rect = canvas.getBoundingClientRect();
        const currentMouseX = event.clientX - rect.left;
        const currentMouseY = event.clientY - rect.top;
        
        // Calculate how much mouse moved from initial position
        const mouseDeltaX = event.clientX - lastMouseX;
        const mouseDeltaY = event.clientY - lastMouseY;
        
        // Track total drag distance
        totalDragDistance += Math.abs(mouseDeltaX) + Math.abs(mouseDeltaY);
        
        // Only start dragging if mouse moved more than 5 pixels (drag threshold)
        const dragThreshold = 5;
        
        if (totalDragDistance > dragThreshold) {
            if (!isDragging) {
                console.log('🖱️ Starting drag');
                // If in bulk mode, start bulk placing
                if (isBulkMode) {
                    bulkPlacing = true;
                    console.log('🚀 Starting BULK DRAG placement');
                }
            }
            isDragging = true;
            
            // If in bulk mode and dragging, place pixels along the path
            if (isBulkMode && bulkPlacing) {
                ensureRegionLoadedForPosition(mouseWorldX, mouseWorldY);
                placePixelBulk(mouseWorldX, mouseWorldY, selectedColor);
            }
            
            // Calculate where the anchor point should be now based on current mouse position
            const viewWidth = canvas.width / zoom;
            const viewHeight = canvas.height / zoom;
            const targetWorldX = cameraX - viewWidth / 2 + currentMouseX / zoom;
            const targetWorldY = cameraY - viewHeight / 2 + currentMouseY / zoom;
            
            // Only move camera if NOT in bulk mode (bulk mode = painting, not panning)
            if (!isBulkMode) {
                // Adjust camera so that the anchor point stays under the mouse
                cameraX += dragStartX - targetWorldX;
                cameraY += dragStartY - targetWorldY;
                
                // Apply bounds checking
                adjustCameraBounds();
                updateVisibleRegions();
            }
        }
    }
}

function updatePositionDisplay() {
    // Ensure CONFIG is loaded
    if (!CONFIG.REGION_SIZE) {
        document.getElementById('regionPos').textContent = '0,0';
        document.getElementById('pixelPos').textContent = '0,0';
        return;
    }
    
    const regionX = Math.floor(mouseWorldX / CONFIG.REGION_SIZE);
    const regionY = Math.floor(mouseWorldY / CONFIG.REGION_SIZE);
    const pixelX = mouseWorldX % CONFIG.REGION_SIZE;
    const pixelY = mouseWorldY % CONFIG.REGION_SIZE;

    document.getElementById('regionPos').textContent = `${regionX},${regionY}`;
    document.getElementById('pixelPos').textContent = `${pixelX},${pixelY}`;
}

function showPixelInfo(event) {
    const tooltip = document.getElementById('pixelInfoTooltip');

    // Check if there's a pixel at this position
    if (mouseWorldX >= 0 && mouseWorldX < CONFIG.CANVAS_SIZE &&
        mouseWorldY >= 0 && mouseWorldY < CONFIG.CANVAS_SIZE) {

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
    if (worldX >= 0 && worldX < CONFIG.CANVAS_SIZE && worldY >= 0 && worldY < CONFIG.CANVAS_SIZE) {
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

function handleMouseUp(event) {
    // If we were dragging, mark it and prevent the click
    if (isDragging) {
        console.log('🖱️ Drag ended');
        wasDragging = true; // Set flag to ignore the upcoming click event
        lastDragEndTime = Date.now(); // Set timestamp
        
        // If we were bulk placing, log completion
        if (bulkPlacing) {
            console.log(`🚀 BULK DRAG completed - placed ${bulkPlacementPath.size} pixels`);
            bulkPlacing = false;
        }
        
        // Force immediate region update after drag (bypass throttling)
        lastRegionUpdateTime = 0; // Reset throttle
        updateVisibleRegions(); // Ensure all visible regions are loaded
        
        // Prevent click event after drag
        event.preventDefault();
        event.stopPropagation();
        
        // Reset the flag after a short delay (in case click event doesn't fire)
        setTimeout(() => {
            wasDragging = false;
        }, 150);
    } else {
        console.log('🎯 Click detected - placing pixel');
        // This was a genuine click, not a drag
        wasDragging = false;
    }
    
    // Reset drag state
    isDragging = false;
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
    const minZoomX = canvas.width / CONFIG.CANVAS_SIZE;
    const minZoomY = canvas.height / CONFIG.CANVAS_SIZE;
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
    
    // FALLBACK: Force check after zoom change
    setTimeout(() => {
        forceLoadAllVisibleRegions();
    }, 200);
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

        // Don't decrement locally - wait for server confirmation
        // The server will send a pixel_bag_update message

        // Removed: addSystemMessage to avoid chat pollution
    }
}

function handleKeyDown(event) {
    console.log('🔑 Key down event fired:', event.code, 'key:', event.key);
    // Only activate bulk mode if not typing in chat
    const chatInput = document.getElementById('chatInput');
    if (document.activeElement === chatInput) {
        console.log('🚫 Ignoring key - typing in chat');
        return; // Don't interfere with chat typing
    }

    if (event.code === 'Space' && !isBulkMode) {
        event.preventDefault(); // Prevent page scroll
        isBulkMode = true;
        bulkPlacementPath.clear(); // Clear previous session
        bulkPreviewPixels.clear(); // Clear preview pixels
        console.log('🚀 BULK MODE ACTIVATED - Preview mode with batch placement on release');
        
        // Visual feedback with animation
        document.body.style.cursor = 'crosshair';
        const bulkIndicator = document.createElement('div');
        bulkIndicator.id = 'bulkIndicator';
        bulkIndicator.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 16px; animation: bounce 0.6s ease-in-out;">🎨</span>
                <div>
                    <div style="font-weight: bold;">BULK PAINT MODE</div>
                    <div style="font-size: 11px; opacity: 0.9;">Preview • Release Space to place</div>
                </div>
                <span id="bulkCounter" style="background: rgba(255,255,255,0.2); padding: 2px 6px; border-radius: 10px; font-size: 12px; transition: all 0.3s ease;">0</span>
            </div>
        `;
        bulkIndicator.style.cssText = `
            position: fixed;
            top: 15px;
            left: 50%;
            transform: translateX(-50%) translateY(-20px);
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 12px 20px;
            border-radius: 25px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 13px;
            z-index: 1000;
            pointer-events: none;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.1);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255,255,255,0.2);
            opacity: 0;
            animation: slideInBounce 0.5s ease-out forwards;
        `;
        document.body.appendChild(bulkIndicator);
        
        // Add CSS animations if not already present
        if (!document.getElementById('bulkAnimations')) {
            const styleSheet = document.createElement('style');
            styleSheet.id = 'bulkAnimations';
            styleSheet.textContent = `
                @keyframes slideInBounce {
                    0% {
                        opacity: 0;
                        transform: translateX(-50%) translateY(-40px) scale(0.8);
                    }
                    50% {
                        opacity: 1;
                        transform: translateX(-50%) translateY(5px) scale(1.05);
                    }
                    100% {
                        opacity: 1;
                        transform: translateX(-50%) translateY(0px) scale(1);
                    }
                }
                
                @keyframes bounce {
                    0%, 20%, 50%, 80%, 100% {
                        transform: translateY(0);
                    }
                    40% {
                        transform: translateY(-8px);
                    }
                    60% {
                        transform: translateY(-4px);
                    }
                }
                
                @keyframes slideOutUp {
                    0% {
                        opacity: 1;
                        transform: translateX(-50%) translateY(0px) scale(1);
                    }
                    100% {
                        opacity: 0;
                        transform: translateX(-50%) translateY(-40px) scale(0.9);
                    }
                }
                
                @keyframes counterPulse {
                    0% { transform: scale(1); }
                    50% { transform: scale(1.2); background: rgba(255,255,255,0.4); }
                    100% { transform: scale(1); }
                }
                
                @keyframes processingGlow {
                    0% { 
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        box-shadow: 0 4px 20px rgba(0,0,0,0.3);
                    }
                    50% { 
                        background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
                        box-shadow: 0 4px 30px rgba(79, 172, 254, 0.5);
                    }
                    100% { 
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        box-shadow: 0 4px 20px rgba(0,0,0,0.3);
                    }
                }
            `;
            document.head.appendChild(styleSheet);
        }
        document.body.appendChild(bulkIndicator);
    }
}

function handleKeyUp(event) {
    console.log('🔑 Key up event fired:', event.code, 'key:', event.key);
    if (event.code === 'Space' && isBulkMode) {
        const previewCount = bulkPreviewPixels.size;
        console.log(`🚀 BULK PLACEMENT: Processing ${previewCount} pixels...`);
        
        const bulkIndicator = document.getElementById('bulkIndicator');
        
        // If there are pixels to process, show processing animation
        if (previewCount > 0) {
            // Update indicator to show processing state
            if (bulkIndicator) {
                bulkIndicator.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="font-size: 16px; animation: bounce 1s infinite;">⚡</span>
                        <div>
                            <div style="font-weight: bold;">PROCESSING...</div>
                            <div style="font-size: 11px; opacity: 0.9;">Placing ${previewCount} pixels</div>
                        </div>
                        <span style="background: rgba(255,255,255,0.2); padding: 2px 6px; border-radius: 10px; font-size: 12px;">${previewCount}</span>
                    </div>
                `;
                bulkIndicator.style.animation = 'processingGlow 1s ease-in-out infinite';
            }
        }
        
        // Send all preview pixels to server in batch
        if (previewCount > 0 && ws && ws.readyState === WebSocket.OPEN) {
            const pixelsArray = Array.from(bulkPreviewPixels.entries()).map(([key, color]) => {
                const [x, y] = key.split(',').map(Number);
                return { x, y, color };
            });
            
            // Send bulk placement request
            ws.send(JSON.stringify({
                type: 'bulk_pixel_place',
                pixels: pixelsArray
            }));
            
            console.log(`📦 BULK: Sent ${pixelsArray.length} pixels to server`);
        }
        
        // Deactivate bulk mode with exit animation
        setTimeout(() => {
            if (bulkIndicator) {
                bulkIndicator.style.animation = 'slideOutUp 0.4s ease-in forwards';
                setTimeout(() => {
                    if (bulkIndicator && bulkIndicator.parentNode) {
                        bulkIndicator.remove();
                    }
                }, 400);
            }
            
            isBulkMode = false;
            bulkPlacing = false;
            bulkPlacementPath.clear();
            bulkPreviewPixels.clear();
            console.log('🛑 BULK MODE DEACTIVATED');
            
            // Remove visual feedback
            document.body.style.cursor = '';
            
            // Force re-render to remove preview pixels
            renderCanvas();
        }, previewCount > 0 ? 1500 : 100); // Longer delay if processing pixels
    }
}

function placePixelBulk(x, y, color) {
    // Check throttling for bulk placement
    const now = Date.now();
    if (now - lastBulkPixelTime < BULK_PLACEMENT_DELAY) {
        return; // Too soon since last bulk pixel
    }
    
    // Check if this pixel was already placed in current bulk session
    const pixelKey = `${x},${y}`;
    if (bulkPlacementPath.has(pixelKey)) {
        return; // Already placed this pixel in current bulk session
    }
    
    // Add to preview (validation will be done on server when sending)
    lastBulkPixelTime = now;
    bulkPlacementPath.add(pixelKey);
    bulkPreviewPixels.set(pixelKey, color);
    
    console.log(`🎨 PREVIEW: Adding pixel at ${x},${y} (${bulkPreviewPixels.size} total preview)`);
    
    // Update bulk indicator with count and animation
    const bulkCounter = document.getElementById('bulkCounter');
    if (bulkCounter) {
        // Show preview count vs available pixels
        const availablePixels = pixelBag;
        const previewCount = bulkPreviewPixels.size;
        
        bulkCounter.textContent = `${previewCount}`;
        
        // Change color based on availability
        if (previewCount > availablePixels) {
            bulkCounter.style.background = 'rgba(239, 68, 68, 0.8)'; // Red if over limit
            bulkCounter.style.color = 'white';
        } else if (previewCount === availablePixels) {
            bulkCounter.style.background = 'rgba(245, 158, 11, 0.8)'; // Orange if at limit
            bulkCounter.style.color = 'white';
        } else {
            bulkCounter.style.background = 'rgba(255,255,255,0.2)'; // Normal
            bulkCounter.style.color = 'white';
        }
        
        // Add pulse animation
        bulkCounter.style.animation = 'counterPulse 0.3s ease-out';
        setTimeout(() => {
            bulkCounter.style.animation = '';
        }, 300);
    }
    
    // Update the main indicator with pixel availability info
    const bulkIndicator = document.getElementById('bulkIndicator');
    if (bulkIndicator && isBulkMode) {
        const availablePixels = pixelBag;
        const previewCount = bulkPreviewPixels.size;
        let statusText = 'Preview • Release Space to place';
        
        if (previewCount > availablePixels) {
            statusText = `⚠️ ${previewCount - availablePixels} over limit • Will place ${availablePixels}`;
        } else if (previewCount === availablePixels) {
            statusText = '✅ Using all available pixels';
        }
        
        bulkIndicator.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 16px; animation: bounce 0.6s ease-in-out;">🎨</span>
                <div>
                    <div style="font-weight: bold;">BULK PAINT MODE</div>
                    <div style="font-size: 11px; opacity: 0.9;">${statusText}</div>
                </div>
                <span id="bulkCounter" style="background: ${bulkCounter ? bulkCounter.style.background : 'rgba(255,255,255,0.2)'}; padding: 2px 6px; border-radius: 10px; font-size: 12px; transition: all 0.3s ease;">${previewCount}</span>
            </div>
        `;
    }
    
    // Force re-render to show preview pixel
    renderCanvas();
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
        
        // Track chat message for achievements
        chatMessagesCount++;
    }
}

function addChatMessage(userId, message, timestamp, userData = null, scroll = true) {
    const chatMessages = document.getElementById('chatMessages');
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message chat';

    const time = new Date(timestamp * 1000).toLocaleTimeString();
    
    // Create username display with level badge
    let userDisplay = userId;
    if (userData) {
        const levelBadge = userData.level ? `<span class="user-level-badge level-${userData.level}">Lv.${userData.level}</span>` : '';
        const roleClass = userData.role === 'admin' ? 'admin-user' : '';
        const displayName = userData.display_name || userData.username || userId;
        const chatColor = userData.chat_color || '#55aaff';
        userDisplay = `${levelBadge}<span class="username ${roleClass}" style="color: ${chatColor}">${displayName}</span>`;
    } else {
        userDisplay = `<span class="username">${userId}</span>`;
    }
    
    messageDiv.innerHTML = `
        <span class="timestamp">[${time}]</span>
        ${userDisplay}:
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

// Authentication Functions
async function showLoginForm() {
    document.getElementById('loginForm').style.display = 'block';
    document.getElementById('registerForm').style.display = 'none';
    document.querySelectorAll('.auth-tab').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.auth-tab')[0].classList.add('active');
}

async function showRegisterForm() {
    document.getElementById('loginForm').style.display = 'none';
    document.getElementById('registerForm').style.display = 'block';
    document.querySelectorAll('.auth-tab').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.auth-tab')[1].classList.add('active');
}

function showAuthError(message) {
    const errorDiv = document.getElementById('authError');
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
}

function hideAuthError() {
    document.getElementById('authError').style.display = 'none';
}

function showAuthLoading(show = true) {
    document.getElementById('authLoading').style.display = show ? 'flex' : 'none';
}

async function handleLogin(event) {
    event.preventDefault();
    hideAuthError();
    showAuthLoading(true);

    const formData = new FormData(event.target);
    const loginData = {
        username: formData.get('username'),
        password: formData.get('password'),
        captcha_answer: formData.get('captcha_answer')
    };

    try {
        const response = await fetch('/auth/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            credentials: 'include', // Include cookies in request
            body: JSON.stringify(loginData)
        });

        const result = await response.json();
        
        if (result.success && result.user) {
            // Authentication successful via cookies
            currentUser = result.user;
            currentUsername = result.user.username; // Add this for profile system
            isAuthenticated = true;
            
            // Update pixel bag from user data
            if (currentUser.pixel_bag_size !== undefined) {
                pixelBag = currentUser.pixel_bag_size;
            }
            if (currentUser.max_pixel_bag_size !== undefined) {
                maxPixelBag = currentUser.max_pixel_bag_size;
            }
            updatePixelBagDisplay();
            
            // Get a WebSocket token for this session
            const checkResponse = await fetch('/auth/check', {
                credentials: 'include'
            });
            const checkResult = await checkResponse.json();
            if (checkResult.ws_token) {
                authToken = checkResult.ws_token;
            }
            
            console.log('✅ Login successful:', currentUser);
            
            // Hide auth modal and show main app
            document.getElementById('authModal').classList.remove('show');
            document.getElementById('mainContainer').style.display = 'flex';
            
            // Update user info
            updateUserInterface();
            
            // Connect to WebSocket
            await connectWebSocket();
            
        } else {
            // Check if CAPTCHA is required
            if (result.message.includes('CAPTCHA required:')) {
                const question = result.message.replace('CAPTCHA required: ', '');
                showCaptchaChallenge(question, 'login');
            } else {
                showAuthError(result.message);
            }
        }
    } catch (error) {
        console.error('Login error:', error);
        showAuthError('Connection error. Please try again.');
    } finally {
        showAuthLoading(false);
    }
}

async function handleRegister(event) {
    event.preventDefault();
    hideAuthError();
    showAuthLoading(true);

    const formData = new FormData(event.target);
    const password = formData.get('password');
    const confirmPassword = formData.get('confirmPassword');

    if (password !== confirmPassword) {
        showAuthError('Passwords do not match');
        showAuthLoading(false);
        return;
    }

    const registerData = {
        username: formData.get('username'),
        password: password
    };

    try {
        const response = await fetch('/auth/register', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            credentials: 'include', // Include cookies in request
            body: JSON.stringify(registerData)
        });

        const result = await response.json();
        
        if (result.success && result.user) {
            // Registration and auto-login successful via cookies
            currentUser = result.user;
            currentUsername = result.user.username; // Add this for profile system
            isAuthenticated = true;
            
            // Update pixel bag from user data
            if (currentUser.pixel_bag_size !== undefined) {
                pixelBag = currentUser.pixel_bag_size;
            }
            if (currentUser.max_pixel_bag_size !== undefined) {
                maxPixelBag = currentUser.max_pixel_bag_size;
            }
            updatePixelBagDisplay();
            
            // Get a WebSocket token for this session
            const checkResponse = await fetch('/auth/check', {
                credentials: 'include'
            });
            const checkResult = await checkResponse.json();
            if (checkResult.ws_token) {
                authToken = checkResult.ws_token;
            }
            
            console.log('✅ Registration and login successful:', currentUser);
            
            // Hide auth modal and show main app
            document.getElementById('authModal').classList.remove('show');
            document.getElementById('mainContainer').style.display = 'flex';
            
            updateUserInterface();
            await connectWebSocket();
        } else {
            showAuthError(result.message || 'Registration failed');
        }
    } catch (error) {
        console.error('Register error:', error);
        showAuthError('Connection error. Please try again.');
    } finally {
        showAuthLoading(false);
    }
}

function showCaptchaChallenge(question, formType) {
    const captchaGroup = document.getElementById(formType + 'CaptchaGroup');
    const captchaQuestion = document.getElementById(formType + 'CaptchaQuestion');
    
    captchaQuestion.textContent = question;
    captchaGroup.style.display = 'block';
}

function updateUserInterface() {
    if (currentUser) {
        // Update any existing user displays
        const userNameElement = document.getElementById('userName');
        const userRoleElement = document.getElementById('userRole');
        
        if (userNameElement) userNameElement.textContent = currentUser.username;
        if (userRoleElement) userRoleElement.textContent = currentUser.role;
        
        // Show admin panel if user is admin
        if (currentUser.role === 'ADMIN') {
            const adminPanelBtn = document.getElementById('adminPanelBtn');
            const adminNavBtn = document.getElementById('adminNavBtn');
            if (adminPanelBtn) adminPanelBtn.style.display = 'inline-block';
            if (adminNavBtn) adminNavBtn.style.display = 'block';
        }
    }
}

async function logout() {
    try {
        // Logout via cookie-based API
        await fetch('/auth/logout', {
            method: 'POST',
            credentials: 'include' // Include cookies
        });
    } catch (error) {
        console.error('Logout error:', error);
    }

    // Clear auth data
    authToken = null;
    currentUser = null;
    isAuthenticated = false;
    
    console.log('✅ Logged out successfully');
    
    // Close WebSocket
    if (ws) {
        ws.close();
        ws = null;
    }
    
    // Show auth modal
    document.getElementById('mainContainer').style.display = 'none';
    document.getElementById('authModal').classList.add('show');
    
    // Reset forms
    document.getElementById('loginFormElement').reset();
    document.getElementById('registerFormElement').reset();
    hideAuthError();
}

async function checkAuthenticationStatus() {
    // Prevent multiple calls
    if (checkAuthenticationStatus._inProgress) {
        console.log('🔄 Authentication check already in progress, skipping...');
        return;
    }
    checkAuthenticationStatus._inProgress = true;
    
    try {
        console.log('🔍 Checking authentication status...');
        
        // Check authentication status via cookie-based API
        const response = await fetch('/auth/check', {
            credentials: 'include' // Include cookies
        });
        
        if (response.ok) {
            const result = await response.json();
            
            if (result.authenticated && result.user && result.ws_token) {
                // User is authenticated via cookies
                currentUser = result.user;
                isAuthenticated = true;
                authToken = result.ws_token; // Use temporary WebSocket token
                
                // Update pixel bag from user data
                if (currentUser.pixel_bag_size !== undefined) {
                    pixelBag = currentUser.pixel_bag_size;
                }
                if (currentUser.max_pixel_bag_size !== undefined) {
                    maxPixelBag = currentUser.max_pixel_bag_size;
                }
                updatePixelBagDisplay();
                
                console.log('✅ User authenticated via cookies:', currentUser);
                console.log('🔑 WebSocket token obtained');
                console.log('🎒 Pixel bag updated:', pixelBag + '/' + maxPixelBag);
                
                // Hide auth modal and show main app
                document.getElementById('authModal').classList.remove('show');
                document.getElementById('mainContainer').style.display = 'flex';
                
                // Ensure canvas is properly sized and visible
                setTimeout(() => {
                    if (canvas) {
                        console.log('🔄 Reconfiguring canvas after authentication...');
                        
                        // Force canvas resize
                        canvas.style.display = 'block';
                        const container = document.querySelector('.canvas-container');
                        const rect = container.getBoundingClientRect();
                        
                        // Ensure minimum canvas size
                        const minWidth = 800;
                        const minHeight = 600;
                        canvas.width = Math.max(rect.width, minWidth);
                        canvas.height = Math.max(rect.height, minHeight);
                        
                        console.log('🔄 Canvas resized to:', canvas.width, 'x', canvas.height);
                        
                        // Recalculate zoom with proper canvas dimensions
                        if (CONFIG.CANVAS_SIZE) {
                            const zoomX = canvas.width / CONFIG.CANVAS_SIZE;
                            const zoomY = canvas.height / CONFIG.CANVAS_SIZE;
                            zoom = Math.max(zoomX, zoomY) * 50;
                            
                            // Ensure zoom is valid
                            if (zoom <= 0 || !isFinite(zoom)) {
                                zoom = 0.1; // Default fallback zoom
                            }
                            
                            console.log('🔄 Recalculated zoom after auth:', zoom);
                        }
                        
                        // Refresh the display
                        adjustCameraBounds();
                        updateVisibleRegions();
                        updateStatus('Connected', 'connected');
                    }
                }, 100);
                
                updateUserInterface();
                await connectWebSocket();
                return;
            }
        }
    } catch (error) {
        console.error('Authentication check error:', error);
    } finally {
        checkAuthenticationStatus._inProgress = false;
    }
    
    // User is not authenticated, show auth modal
    console.log('🔐 User not authenticated, showing login form');
    document.getElementById('authModal').classList.add('show');
    document.getElementById('mainContainer').style.display = 'none';
}

async function checkStoredAuth() {
    // This function is now deprecated in favor of checkAuthenticationStatus
    // and is only kept for backward compatibility. It should not be called.
    console.log('⚠️ checkStoredAuth is deprecated, use checkAuthenticationStatus instead');
}

// Admin Panel Functions
async function openAdminPanel() {
    document.getElementById('adminModal').style.display = 'flex';
    await refreshUsers();
}

function closeAdminPanel() {
    document.getElementById('adminModal').style.display = 'none';
}

function showUsersTab() {
    document.getElementById('usersTab').style.display = 'block';
    document.getElementById('statsTab').style.display = 'none';
    document.querySelectorAll('.admin-tab').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.admin-tab')[0].classList.add('active');
}

function showStatsTab() {
    document.getElementById('usersTab').style.display = 'none';
    document.getElementById('statsTab').style.display = 'block';
    document.querySelectorAll('.admin-tab').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.admin-tab')[1].classList.add('active');
    loadStats();
}

async function refreshUsers() {
    try {
        const response = await fetch('/auth/admin/users', {
            headers: {
                'Authorization': `Bearer ${authToken}`
            }
        });
        
        if (response.ok) {
            const users = await response.json();
            displayUsers(users);
        }
    } catch (error) {
        console.error('Error loading users:', error);
    }
}

function displayUsers(users) {
    const usersList = document.getElementById('usersList');
    usersList.innerHTML = '';
    
    users.forEach(user => {
        const userItem = document.createElement('div');
        userItem.className = 'user-item';
        
        const statusClass = user.is_banned ? 'banned' : user.role.toLowerCase();
        const banInfo = user.is_banned ? 
            `<br><small>Banned: ${user.ban_reason || 'No reason'}</small>` : '';
        
        userItem.innerHTML = `
            <div class="user-info-admin">
                <div class="user-name-admin">
                    ${user.username} 
                    <span class="user-level-badge">Level ${user.user_level}</span>
                </div>
                <div class="user-details">
                    Created: ${new Date(user.created_at).toLocaleDateString()}
                    ${user.last_login ? `| Last login: ${new Date(user.last_login).toLocaleDateString()}` : ''}
                    ${banInfo}
                </div>
                <div class="user-stats">
                    <div class="stat-item">
                        <label>Pixels: </label>
                        <input type="number" class="admin-input" value="${user.pixel_bag_size}" 
                               onchange="updateUserData('${user.username}', 'pixel_bag_size', this.value)">
                        /
                        <input type="number" class="admin-input" value="${user.max_pixel_bag_size}" 
                               onchange="updateUserData('${user.username}', 'max_pixel_bag_size', this.value)">
                    </div>
                    <div class="stat-item">
                        <label>XP: </label>
                        <input type="number" class="admin-input" value="${user.experience_points}" 
                               onchange="updateUserData('${user.username}', 'experience_points', this.value)">
                    </div>
                    <div class="stat-item">
                        <label>Level: </label>
                        <input type="number" class="admin-input" value="${user.user_level}" 
                               onchange="updateUserData('${user.username}', 'user_level', this.value)">
                    </div>
                    <div class="stat-item">
                        <label>Display Name: </label>
                        <input type="text" class="admin-input" value="${user.display_name || user.username}" 
                               onchange="updateUserData('${user.username}', 'display_name', this.value)" maxlength="30">
                    </div>
                    <div class="stat-item">
                        <label>Chat Color: </label>
                        <input type="color" class="admin-input" value="${user.chat_color || '#55aaff'}" 
                               onchange="updateUserData('${user.username}', 'chat_color', this.value)">
                    </div>
                    <div class="stat-item">
                        <label>Total Pixels: </label>
                        <span>${user.total_pixels_placed}</span>
                    </div>
                </div>
            </div>
            <div class="user-status ${statusClass}">${user.role}</div>
            <div class="user-actions-admin">
                ${user.is_banned ? 
                    `<button class="btn btn-success" onclick="unbanUser('${user.username}')">Unban</button>` :
                    user.username !== currentUser.username ? 
                        `<button class="btn btn-danger" onclick="showBanModal('${user.username}')">Ban</button>` : ''
                }
            </div>
        `;
        
        usersList.appendChild(userItem);
    });
}

function filterUsers() {
    const searchTerm = document.getElementById('userSearchInput').value.toLowerCase();
    const userItems = document.querySelectorAll('.user-item');
    
    userItems.forEach(item => {
        const username = item.querySelector('.user-name-admin').textContent.toLowerCase();
        item.style.display = username.includes(searchTerm) ? 'flex' : 'none';
    });
}

function showBanModal(username) {
    document.getElementById('banUsername').value = username;
    document.getElementById('banModal').style.display = 'flex';
}

function closeBanModal() {
    document.getElementById('banModal').style.display = 'none';
    document.getElementById('banForm').reset();
}

async function handleBanUser(event) {
    event.preventDefault();
    
    const formData = new FormData(event.target);
    const banData = {
        username: formData.get('banUsername'),
        reason: formData.get('banReason'),
        temporary: formData.has('banTemporary')
    };
    
    try {
        const response = await fetch('/auth/admin/ban', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify(banData)
        });
        
        if (response.ok) {
            closeBanModal();
            await refreshUsers();
        }
    } catch (error) {
        console.error('Error banning user:', error);
    }
}

async function unbanUser(username) {
    try {
        const response = await fetch(`/auth/admin/unban/${username}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authToken}`
            }
        });
        
        if (response.ok) {
            await refreshUsers();
        }
    } catch (error) {
        console.error('Error unbanning user:', error);
    }
}

async function loadStats() {
    try {
        const [usersResponse, statsResponse] = await Promise.all([
            fetch('/auth/admin/users', {
                headers: { 'Authorization': `Bearer ${authToken}` }
            }),
            fetch('/api/stats', {
                headers: { 'Authorization': `Bearer ${authToken}` }
            })
        ]);
        
        if (usersResponse.ok && statsResponse.ok) {
            const users = await usersResponse.json();
            const stats = await statsResponse.json();
            
            document.getElementById('totalUsers').textContent = users.length;
            document.getElementById('activeUsers').textContent = stats.active_users || 0;
            document.getElementById('bannedUsers').textContent = 
                users.filter(u => u.is_banned).length;
            document.getElementById('totalPixels').textContent = stats.total_pixels || 0;
        }
    } catch (error) {
        console.error('Error loading stats:', error);
    }
}

// Set up event listeners
document.addEventListener('DOMContentLoaded', function() {
    // Auth form listeners
    document.getElementById('loginFormElement').addEventListener('submit', handleLogin);
    document.getElementById('registerFormElement').addEventListener('submit', handleRegister);
    document.getElementById('banForm').addEventListener('submit', handleBanUser);
    
    // Authentication will be checked during initialization
    console.log('🎧 Event listeners setup complete');
});

// Admin function to update user data
async function updateUserData(username, field, value) {
    try {
        const response = await fetch('/auth/admin/update-user', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({
                username: username,
                field: field,
                value: String(value)  // Convert to string since API expects string
            })
        });
        
        if (response.ok) {
            console.log(`✅ Updated ${username} ${field} to ${value}`);
        } else {
            const errorData = await response.json();
            console.error('Failed to update user data:', errorData);
        }
    } catch (error) {
        console.error('Error updating user data:', error);
    }
}

function createBulkSuccessAnimation(placed, total) {
    // Create confetti animation for successful bulk placement
    const confettiContainer = document.createElement('div');
    confettiContainer.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        pointer-events: none;
        z-index: 9999;
    `;
    document.body.appendChild(confettiContainer);
    
    // Create success notification
    const successNotification = document.createElement('div');
    successNotification.innerHTML = `
        <div style="display: flex; align-items: center; gap: 12px;">
            <span style="font-size: 24px; animation: bounce 0.6s ease-in-out;">🎉</span>
            <div>
                <div style="font-weight: bold; font-size: 16px;">BULK COMPLETE!</div>
                <div style="font-size: 12px; opacity: 0.9;">${placed}/${total} pixels placed</div>
            </div>
            <span style="font-size: 20px; animation: bounce 0.6s ease-in-out 0.2s;">✨</span>
        </div>
    `;
    successNotification.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%) scale(0);
        background: linear-gradient(135deg, #4ade80 0%, #22c55e 100%);
        color: white;
        padding: 20px 30px;
        border-radius: 30px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        z-index: 10000;
        pointer-events: none;
        box-shadow: 0 8px 32px rgba(34, 197, 94, 0.4);
        backdrop-filter: blur(10px);
        border: 2px solid rgba(255,255,255,0.3);
        animation: successPop 2s ease-out forwards;
    `;
    document.body.appendChild(successNotification);
    
    // Add success animation styles
    if (!document.getElementById('successAnimations')) {
        const styleSheet = document.createElement('style');
        styleSheet.id = 'successAnimations';
        styleSheet.textContent = `
            @keyframes successPop {
                0% {
                    opacity: 0;
                    transform: translate(-50%, -50%) scale(0);
                }
                20% {
                    opacity: 1;
                    transform: translate(-50%, -50%) scale(1.1);
                }
                100% {
                    opacity: 0;
                    transform: translate(-50%, -50%) scale(0.8);
                }
            }
            
            @keyframes confettiFall {
                0% {
                    opacity: 1;
                    transform: translateY(-100vh) rotate(0deg);
                }
                100% {
                    opacity: 0;
                    transform: translateY(100vh) rotate(720deg);
                }
            }
        `;
        document.head.appendChild(styleSheet);
    }
    
    // Create confetti particles
    const colors = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#ffa726', '#ab47bc'];
    for (let i = 0; i < (placed > 10 ? 30 : 15); i++) {
        const confetti = document.createElement('div');
        confetti.style.cssText = `
            position: absolute;
            width: ${Math.random() * 8 + 4}px;
            height: ${Math.random() * 8 + 4}px;
            background: ${colors[Math.floor(Math.random() * colors.length)]};
            left: ${Math.random() * 100}vw;
            animation: confettiFall ${Math.random() * 2 + 2}s linear forwards;
            animation-delay: ${Math.random() * 0.5}s;
            border-radius: ${Math.random() > 0.5 ? '50%' : '0'};
        `;
        confettiContainer.appendChild(confetti);
    }
    
    // Clean up after animation
    setTimeout(() => {
        if (confettiContainer.parentNode) {
            confettiContainer.remove();
        }
        if (successNotification.parentNode) {
            successNotification.remove();
        }
    }, 4000);
}

// ==================== TUTORIAL SYSTEM ====================
let currentTutorialStep = 1;

function showTutorial() {
    const tutorialModal = document.getElementById('tutorialModal');
    tutorialModal.classList.add('show');
    currentTutorialStep = 1;
    updateTutorialStep();
}

function closeTutorial() {
    const tutorialModal = document.getElementById('tutorialModal');
    const dontShowAgain = document.getElementById('dontShowAgain').checked;
    
    tutorialModal.classList.remove('show');
    
    if (dontShowAgain) {
        localStorage.setItem('pixelplace_tutorial_dismissed', 'true');
    }
}

function nextStep() {
    if (currentTutorialStep < 5) {
        currentTutorialStep++;
        updateTutorialStep();
    } else {
        closeTutorial();
    }
}

function previousStep() {
    if (currentTutorialStep > 1) {
        currentTutorialStep--;
        updateTutorialStep();
    }
}

function goToStep(step) {
    currentTutorialStep = step;
    updateTutorialStep();
}

function updateTutorialStep() {
    // Hide all steps
    document.querySelectorAll('.tutorial-step').forEach(step => {
        step.classList.remove('active');
    });
    
    // Show current step
    document.getElementById(`step${currentTutorialStep}`).classList.add('active');
    
    // Update dots
    document.querySelectorAll('.dot').forEach((dot, index) => {
        dot.classList.toggle('active', index + 1 === currentTutorialStep);
    });
    
    // Update navigation buttons
    document.getElementById('prevBtn').disabled = currentTutorialStep === 1;
    document.getElementById('nextBtn').textContent = currentTutorialStep === 5 ? 'Finish' : 'Next';
}

// ==================== PROFILE SYSTEM ====================
function openProfile() {
    const profileModal = document.getElementById('profileModal');
    profileModal.classList.add('show');
    loadProfileData();
}

function closeProfile() {
    const profileModal = document.getElementById('profileModal');
    profileModal.classList.remove('show');
}

function loadProfileData() {
    // Update profile info with current user data
    if (currentUsername) {
        document.getElementById('profileUsername').textContent = currentUsername;
        
        // Calculate level based on pixels placed (example)
        const level = Math.floor(pixelsPlacedCount / 10) + 1;
        document.getElementById('profileLevel').textContent = `Level ${level}`;
        
        // Update stats
        document.getElementById('statPixelsPlaced').textContent = pixelsPlacedCount || 0;
        document.getElementById('statPixelBag').textContent = `${pixelBag}/${maxPixelBag}`;
        
        // Calculate time active (example - you'd track this properly)
        const timeActive = Math.floor((Date.now() - sessionStartTime) / 60000); // minutes
        document.getElementById('statTimeActive').textContent = timeActive < 60 ? 
            `${timeActive}m` : `${Math.floor(timeActive / 60)}h ${timeActive % 60}m`;
        
        // Join date (you'd get this from server)
        document.getElementById('statJoinDate').textContent = 'Today';
        
        // Update achievements
        updateAchievements();
    }
}

function updateAchievements() {
    const achievements = document.querySelectorAll('.achievement');
    
    // First Pixel achievement
    if (pixelsPlacedCount > 0) {
        achievements[0].classList.remove('locked');
        achievements[0].classList.add('unlocked');
    }
    
    // On Fire achievement (100 pixels)
    if (pixelsPlacedCount >= 100) {
        achievements[1].classList.remove('locked');
        achievements[1].classList.add('unlocked');
    }
    
    // Bulk Master achievement (you'd track this)
    if (bulkPlacementsCount >= 10) {
        achievements[2].classList.remove('locked');
        achievements[2].classList.add('unlocked');
    }
    
    // Social Artist achievement (you'd track this)
    if (chatMessagesCount >= 50) {
        achievements[3].classList.remove('locked');
        achievements[3].classList.add('unlocked');
    }
}

// Track statistics for achievements
let pixelsPlacedCount = 0;
let bulkPlacementsCount = 0;
let chatMessagesCount = 0;
let sessionStartTime = Date.now();

// Show tutorial on first visit
window.addEventListener('load', () => {
    setTimeout(() => {
        const tutorialDismissed = localStorage.getItem('pixelplace_tutorial_dismissed');
        if (!tutorialDismissed) {
            showTutorial();
        }
    }, 2000); // Show after 2 seconds to let everything load
});

// Initialize the application when DOM is ready
init();
