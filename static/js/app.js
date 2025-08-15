let colorEffectMap = new Map(); // Map color hex -> effect name (glow, spark) gathered from owned colors list
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
let bagNextPixelIn = 0;
let bagFullEta = 0;
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
// Performance helpers for bulk preview rendering
const BULK_PREVIEW_SIMPLE_THRESHOLD = 250; // Above this, use simpler rendering to avoid lag
let renderPending = false; // Guard multiple renders per frame
let lastBulkIndicatorUpdate = 0; // Throttle indicator DOM updates
const BULK_INDICATOR_UPDATE_MS = 60; // Min ms between indicator updates

function scheduleRender() {
    if (!renderPending) {
        renderPending = true;
        requestAnimationFrame(() => {
            renderPending = false;
            renderCanvas();
        });
    }
}

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

    console.log('Setting up canvas...');
        setupCanvas();
        
    console.log('Setting up color palette...');
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
        
    console.log('Initialization complete. Checking authentication...');
        
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

// Centralized event listener setup (previously missing causing ReferenceError)
function setupEventListeners(){
    if(!canvas) return;
    // Mouse core
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('mouseleave', handleMouseLeave);
    canvas.addEventListener('click', handleCanvasClick, true);
    canvas.addEventListener('wheel', handleWheel, { passive:false });
    // Keyboard
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    // Visibility (pause heavy ops if desired later)
    document.addEventListener('visibilitychange', ()=>{ /* placeholder for future pause/resume */ });
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
    
    console.log('Canvas setup - container rect:', rect.width, 'x', rect.height);
    console.log('Canvas final size:', canvas.width, 'x', canvas.height);

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

// Center camera helper (navbar logo)
function zoomToCenter() {
    cameraX = CONFIG.CANVAS_SIZE / 2;
    cameraY = CONFIG.CANVAS_SIZE / 2;
    // Gentle animation effect could be added; for now just re-render
    updateVisibleRegions();
    renderCanvas();
}

function setupColorPalette() {
    // Show placeholder base palette; real owned colors load only after auth.
    const colorGrid = document.getElementById('colorGrid');
    if (!colorGrid) return;
    colorGrid.innerHTML='';
    const placeholder = [
        '#FF0000','#00FF00','#0000FF','#FFFF00','#FF00FF','#00FFFF',
        '#FFFFFF','#000000','#800000','#008000','#000080','#808000',
        '#800080','#008080','#C0C0C0','#808080'
    ];
    placeholder.forEach((col, idx)=>{
        const btn = document.createElement('div');
        btn.className='color-btn placeholder';
        if(idx===0) btn.classList.add('selected');
        btn.style.backgroundColor=col;
        btn.title='Login to load owned colors';
        btn.onclick=()=>selectColor(col, btn);
        colorGrid.appendChild(btn);
    });
    // Owned colors fetched later by loadOwnedColors() after auth success.
}

// Reward scaling indicator logic
let rewardScaleLastFetch = 0;
let rewardScaleIntervalId = null; // started only after auth
async function updateRewardScaleIndicator() {
    const now = Date.now();
    if (now - rewardScaleLastFetch < 3000) return; // throttle 3s
    // Skip if not authenticated to avoid 403 spam on server logs
    if (!authToken) return;
    rewardScaleLastFetch = now;
    try {
        const r = await fetch('/api/reward/scale', { headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {} });
        if (!r.ok) return;
        const data = await r.json();
        const pct = data.scale_percent ?? Math.round((data.scale||1)*100);
        const ring = document.getElementById('rsFill');
        const txt = document.getElementById('rsText');
        if (ring) {
            const deg = (pct/100)*360;
            ring.style.background = `conic-gradient(var(--success) 0deg, var(--warning) ${deg*0.6}deg, var(--error) ${deg}deg, rgba(255,255,255,0.1) ${deg}deg 360deg)`;
        }
        if (txt) txt.textContent = pct + '%';
    } catch(e) { /* silent */ }
}
// Interval started after authentication succeeds (see checkAuthenticationStatus)
// (Removed early setInterval to avoid unauthenticated calls)

// Provide missing handler referenced in setupEventListeners (defined once below)
function handleMouseLeave(e){
    if (isDragging) { isDragging = false; wasDragging = false; }
    if (typeof hidePixelPreview === 'function') { try { hidePixelPreview(); } catch(_){} }
}

// Extracted loader for owned colors (was inline earlier)
async function loadOwnedColors(){
    try {
        if(!authToken) return; // require auth
        const colorGrid = document.getElementById('colorGrid');
        if (colorGrid){
            colorGrid.innerHTML = `<div class="color-loading"><div class="spinner"></div><span>Carregando cores...</span></div>`;
        }
        const r = await fetch('/api/inventory/colors', { headers: { 'Authorization': `Bearer ${authToken}` }});
        if(!r.ok) return;
        const data = await r.json();
        if (!colorGrid) return;
        colorGrid.innerHTML='';
        let list = data.colors || [];
        if(!Array.isArray(list) || list.length===0){
            list = [];
        }
        const basicIfEmpty = list.length===0;
        if(basicIfEmpty){
            list = [
                {color:'#FF0000', name:'Basic Red', rarity:'COMMON'},
                {color:'#00FF00', name:'Basic Green', rarity:'COMMON'},
                {color:'#0000FF', name:'Basic Blue', rarity:'COMMON'},
                {color:'#FFFF00', name:'Basic Yellow', rarity:'COMMON'},
                {color:'#FF00FF', name:'Basic Magenta', rarity:'COMMON'},
                {color:'#00FFFF', name:'Basic Cyan', rarity:'COMMON'},
                {color:'#FFFFFF', name:'Basic White', rarity:'COMMON'},
                {color:'#000000', name:'Basic Black', rarity:'COMMON'},
                {color:'#800000', name:'Basic Maroon', rarity:'COMMON'},
                {color:'#008000', name:'Basic DarkGreen', rarity:'COMMON'},
                {color:'#000080', name:'Basic Navy', rarity:'COMMON'},
                {color:'#808000', name:'Basic Olive', rarity:'COMMON'},
                {color:'#800080', name:'Basic Purple', rarity:'COMMON'},
                {color:'#008080', name:'Basic Teal', rarity:'COMMON'},
                {color:'#C0C0C0', name:'Basic Silver', rarity:'COMMON'},
                {color:'#808080', name:'Basic Gray', rarity:'COMMON'}
            ];
        }
        // Track previous colors across reloads to detect newly unlocked
        if(!window._prevOwnedColors) window._prevOwnedColors = new Set();
        const prev = window._prevOwnedColors;
        const newly = [];
        list.forEach((c)=>{ if (c && c.color && !prev.has(c.color.toLowerCase())) newly.push(c.color.toLowerCase()); });

        list.forEach((c, idx)=>{
            const btn = document.createElement('div');
            btn.className='color-btn';
            if (c.effect === 'glow' || (c.tags||[]).includes('effect:glow')) { btn.classList.add('effect-glow'); colorEffectMap.set(c.color.toLowerCase(), 'glow'); }
            if (c.effect === 'spark' || (c.tags||[]).includes('effect:spark')) { btn.classList.add('effect-spark'); colorEffectMap.set(c.color.toLowerCase(), 'spark'); }
            if(idx===0) btn.classList.add('selected');
            btn.style.backgroundColor=c.color;
            btn.title=`${c.name} (${c.rarity})`;
            btn.onclick=()=>selectColor(c.color, btn);
            if (newly.includes(c.color.toLowerCase())) {
                btn.classList.add('new-color');
                // Remove highlight after a few seconds
                setTimeout(()=>btn.classList.remove('new-color'), 6000);
            }
            colorGrid.appendChild(btn);
        });
        // Update previous set
        list.forEach(c=>{ if(c && c.color) prev.add(c.color.toLowerCase()); });
    } catch(e){ console.warn('Failed loading owned colors', e); }
}

function selectColor(color, element){
    selectedColor = color;
    document.querySelectorAll('.color-btn').forEach(btn=>btn.classList.remove('selected'));
    if(element) element.classList.add('selected');
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

// Pixel Bag System (server authoritative)
function startPixelBagSystem(initial) {
    if (initial) {
        if (initial.pixel_bag_size !== undefined) pixelBag = initial.pixel_bag_size;
        if (initial.max_pixel_bag_size !== undefined) maxPixelBag = initial.max_pixel_bag_size;
    }
    updatePixelBagDisplay();
    if (bagRefillInterval) clearInterval(bagRefillInterval);
    bagRefillInterval = setInterval(() => {
        if (pixelBag >= maxPixelBag) {
            updateRefillETA();
            return;
        }
        if (bagNextPixelIn > 0) bagNextPixelIn--;
        if (bagNextPixelIn <= 0) {
            syncPixelBag();
        }
        updateRefillETA();
    }, 1000);
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

    updateRefillETA();
}

// Estimate refill ETA (client-side heuristic; server authoritative on bag size)
function updateRefillETA() {
    const etaEl = document.getElementById('pixelRefillEta');
    if (!etaEl) return;
    if (pixelBag >= maxPixelBag) {
        etaEl.textContent = 'Full';
        etaEl.className = 'refill-eta full';
        return;
    }
    if (bagNextPixelIn > 0) {
        etaEl.textContent = bagNextPixelIn + 's';
    } else {
        etaEl.textContent = 'sync';
    }
    etaEl.className = 'refill-eta ticking';
}

async function syncPixelBag() {
    if (!authToken) return;
    try {
        const r = await fetch('/api/pixel_bag/sync', { headers: { 'Authorization': `Bearer ${authToken}` }});
        if (!r.ok) {
            if (r.status === 401 || r.status === 403) {
                console.warn('Pixel bag sync unauthorized, stopping further sync attempts');
                clearInterval(bagRefillInterval);
            }
            return;
        }
        const data = await r.json();
        pixelBag = data.pixel_bag_size;
        maxPixelBag = data.max_pixel_bag_size;
        bagNextPixelIn = data.next_pixel_in;
        bagFullEta = data.full_refill_eta;
        updatePixelBagDisplay();
    } catch (e) {
        console.warn('Pixel bag sync failed', e);
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
        console.log(`Region fallback load ${regionKey} for hover at ${worldX},${worldY}`);
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
    
    console.log(`Force loading regions ${startRegionX}-${endRegionX} x ${startRegionY}-${endRegionY}`);
    
    let forcedLoads = 0;
    for (let x = startRegionX; x <= endRegionX; x++) {
        for (let y = startRegionY; y <= endRegionY; y++) {
            const regionKey = `${x},${y}`;
            if (!loadedRegions.has(regionKey)) {
                console.log(`Force: loading region ${regionKey}`);
                loadRegionPixels(x, y);
                loadedRegions.add(regionKey);
                forcedLoads++;
            }
        }
    }
    
    console.log(`Force loaded ${forcedLoads} regions`);
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

    // Draw base pixels & collect those with effects for second pass
    const effectPixels = [];
    for (const [pixelKey, pixel] of pixelData.entries()) {
        const [x, y] = pixelKey.split(',').map(Number);
        if (x >= leftX && x < leftX + viewWidth && y >= topY && y < topY + viewHeight) {
            const screenX = (x - leftX) * zoom;
            const screenY = (y - topY) * zoom;
            ctx.fillStyle = pixel.color;
            ctx.fillRect(screenX, screenY, zoom, zoom);
            if (pixel.effect === 'glow' || pixel.effect === 'spark') {
                effectPixels.push({x,y,screenX,screenY,pixel});
            }
        }
    }

    if (effectPixels.length) {
        const time = performance.now() * 0.001;
        // Glow halos
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (const ep of effectPixels) {
            if (ep.pixel.effect !== 'glow') continue;
            const radius = zoom * 2.3;
            const cx = ep.screenX + zoom/2;
            const cy = ep.screenY + zoom/2;
            const grad = ctx.createRadialGradient(cx, cy, zoom*0.2, cx, cy, radius);
            grad.addColorStop(0, hexToRgba(ep.pixel.color, 0.85));
            grad.addColorStop(0.4, hexToRgba(ep.pixel.color, 0.35));
            grad.addColorStop(1, hexToRgba(ep.pixel.color, 0));
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(cx, cy, radius, 0, Math.PI*2);
            ctx.fill();
        }
        ctx.restore();
        // Spark twinkles
        ctx.save();
        for (const ep of effectPixels) {
            if (ep.pixel.effect !== 'spark') continue;
            const phase = (Math.sin((ep.x*31 + ep.y*17) + time*6) + 1)/2; // 0..1
            if (phase < 0.45) continue;
            const intensity = (phase - 0.45) / 0.55; // 0..1
            const size = Math.max(1, Math.min(zoom, zoom*0.5 + intensity*zoom*0.6));
            const sx = ep.screenX + zoom/2;
            const sy = ep.screenY + zoom/2;
            ctx.globalAlpha = 0.4 + 0.6*intensity;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(sx - size/2, sy - size/2, size, size);
            if (zoom > 6) {
                ctx.globalAlpha = 0.2 + 0.5*intensity;
                ctx.strokeStyle = ep.pixel.color;
                ctx.lineWidth = 1;
                ctx.strokeRect(ep.screenX - 0.5, ep.screenY - 0.5, zoom + 1, zoom + 1);
            }
        }
        ctx.globalAlpha = 1;
        ctx.restore();
    }

    // Draw preview pixels (bulk mode) with adaptive complexity for performance
    if (isBulkMode && bulkPreviewPixels.size > 0) {
        const simpleMode = bulkPreviewPixels.size > BULK_PREVIEW_SIMPLE_THRESHOLD;
        const time = Date.now() * 0.003;
        for (const [pixelKey, color] of bulkPreviewPixels.entries()) {
            const [x, y] = pixelKey.split(',').map(Number);
            if (x >= leftX && x < leftX + viewWidth && y >= topY && y < topY + viewHeight) {
                const screenX = (x - leftX) * zoom;
                const screenY = (y - topY) * zoom;
                if (simpleMode) {
                    ctx.globalAlpha = 0.55;
                    ctx.fillStyle = color;
                    ctx.fillRect(screenX, screenY, zoom, zoom);
                } else {
                    const pulse = 0.1 + 0.1 * Math.sin(time + x * 0.1 + y * 0.1);
                    ctx.fillStyle = color;
                    ctx.globalAlpha = 0.6 + pulse;
                    ctx.fillRect(screenX, screenY, zoom, zoom);
                    ctx.globalAlpha = 0.8 + pulse * 0.5;
                    ctx.strokeStyle = '#ffffff';
                    ctx.lineWidth = Math.max(1, zoom * 0.1) + pulse;
                    ctx.strokeRect(screenX - pulse, screenY - pulse, zoom + pulse * 2, zoom + pulse * 2);
                    ctx.globalAlpha = 0.9;
                    ctx.strokeStyle = color;
                    ctx.lineWidth = Math.max(0.5, zoom * 0.05);
                    ctx.strokeRect(screenX + 1, screenY + 1, zoom - 2, zoom - 2);
                    if (zoom > 4) {
                        const sparkle = Math.sin(time * 2 + x * 0.5 + y * 0.5);
                        if (sparkle > 0.7) {
                            ctx.fillStyle = '#ffffff';
                            ctx.globalAlpha = sparkle - 0.5;
                            const sparkleSize = 2;
                            ctx.fillRect(screenX + zoom/2 - sparkleSize/2, screenY + zoom/2 - sparkleSize/2, sparkleSize, sparkleSize);
                        }
                    }
                }
            }
        }
        ctx.globalAlpha = 1;
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
            // Load achievements from backend and merge with local (union)
            currentUsername = data.user.username;
            // Economy / XP initial sync
            updateEconomyFromPayload(data.user);
            // Pixel bag initial snapshot
            if (data.user.pixel_bag_size !== undefined) {
                pixelBag = data.user.pixel_bag_size;
                maxPixelBag = data.user.max_pixel_bag_size;
                bagNextPixelIn = data.user.next_pixel_in ?? CONFIG.PIXEL_REFILL_RATE;
                bagFullEta = data.user.full_refill_eta ?? 0;
                startPixelBagSystem({ pixel_bag_size: pixelBag, max_pixel_bag_size: maxPixelBag });
                updatePixelBagDisplay();
            }
            fetch('/api/achievements', { headers: { 'Authorization': `Bearer ${authToken}` }})
                .then(r => r.json())
                .then(serverData => {
                    loadUnlockedAchievements(); // local
                    const serverSet = new Set(serverData.achievements || []);
                    const merged = new Set([...serverSet, ...unlockedAchievements]);
                    unlockedAchievements = merged;
                    persistUnlockedAchievements();
                    renderAchievementsGrid();
                })
                .catch(e => console.warn('Failed to load server achievements', e));
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
            updatePixel(data.x, data.y, data.color, data.effect);
            
            // Track pixel placement for achievements (only if it's the current user)
            if (data.user_id === currentUsername) {
                pixelsPlacedCount++;
                achievementCountChanged();
            }
            break;
        case 'pixel_batch_update':
            // New optimized batch update
            if (Array.isArray(data.updates)) {
                for (const upd of data.updates) {
                    updatePixel(upd.x, upd.y, upd.color, upd.effect);
                    if (upd.user_id === currentUsername) {
                        pixelsPlacedCount++;
                    }
                }
                achievementCountChanged();
            }
            break;
        case 'reward_scale_update':
            // Update reward scale indicator live without waiting for poll
            if (typeof data.scale_percent === 'number') {
                const pct = data.scale_percent;
                const ring = document.getElementById('rsFill');
                const txt = document.getElementById('rsText');
                if (ring) {
                    const deg = (pct/100)*360;
                    ring.style.background = `conic-gradient(var(--success) 0deg, var(--warning) ${deg*0.6}deg, var(--error) ${deg}deg, rgba(255,255,255,0.1) ${deg}deg 360deg)`;
                }
                if (txt) txt.textContent = pct + '%';
            }
            break;
        case 'pixel_bag_update':
            console.log('📦 Received pixel bag update:', data);
            pixelBag = data.pixel_bag_size;
            maxPixelBag = data.max_pixel_bag_size;
            bagNextPixelIn = data.next_pixel_in ?? CONFIG.PIXEL_REFILL_RATE;
            bagFullEta = data.full_refill_eta ?? bagFullEta;
            updatePixelBagDisplay();
            updateRefillETA();
            // Optional economy fields piggyback
            updateEconomyFromPayload(data);
            break;
        case 'level_up':
            if (data.user_id === currentUsername) {
                addSystemMessage(`🎉 Level Up! Agora nível ${data.new_level} (+${(data.levels||[]).map(l=>l.coin_reward).reduce((a,b)=>a+b,0)} coins)`);
                flashEconomyBar();
            } else {
                addSystemMessage(`🎉 ${data.user_id} subiu para nível ${data.new_level}`);
            }
            updateEconomyFromPayload(data);
            break;
        case 'bulk_complete':
            console.log(`🚀 Bulk placement complete: ${data.placed}/${data.requested} pixels placed (available at start: ${data.available_at_start})`);
            // Update economy/XP if present in summary
            updateEconomyFromPayload(data);
            
            // Track bulk placement for achievements
            if (data.placed > 0) {
                bulkPlacementsCount++;
                pixelsPlacedCount += data.placed; // Add the placed pixels to total count
                achievementCountChanged();
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
            
            const remainingMsg = typeof data.remaining === 'number' ? ` • Remaining: ${data.remaining}` : '';
            const durationMsg = typeof data.duration_ms === 'number' ? ` • ${data.duration_ms}ms` : '';
            if (data.placed < data.requested) {
                addSystemMessage(`⚠️ Bulk: ${data.placed}/${data.requested} placed (bag/time limit)${remainingMsg}${durationMsg}`);
            } else {
                addSystemMessage(`✅ Bulk OK: ${data.placed}/${data.requested}${remainingMsg}${durationMsg}`);
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
        case 'new_item_unlocked':
            handleNewItemUnlocked(data);
            break;
        case 'reward_scale_update': // already handled earlier but guard if duplicated
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
                user_id: pixel.user_id,
                effect: pixel.effect || (pixel.color ? colorEffectMap.get(pixel.color.toLowerCase()) : null) || null
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
                    user_id: pixel.user_id,
                    effect: pixel.effect || (pixel.color ? colorEffectMap.get(pixel.color.toLowerCase()) : null) || null
                });
            });
            renderCanvas();
        }
    } catch (error) {
        console.log(`Failed to load region ${regionX},${regionY}:`, error);
    }
}

function updatePixel(globalX, globalY, color, effect) {
    console.log('DEBUG: Updating pixel at', globalX, globalY, 'with color', color, 'effect', effect);
    
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
    const inferred = effect || colorEffectMap.get((color||'').toLowerCase()) || null;
    pixelData.set(pixelKey, { color, effect: inferred, timestamp: Date.now()/1000, user_id: 'other' });
    console.log('DEBUG: Pixel stored, re-rendering canvas. Total pixels:', pixelData.size);
    renderCanvas();
}

function hexToRgba(hex, alpha) {
    if (!hex) return `rgba(255,255,255,${alpha||1})`;
    let h = hex.replace('#','');
    if (h.length === 3) h = h.split('').map(c=>c+c).join('');
    const num = parseInt(h,16);
    const r = (num>>16)&255, g=(num>>8)&255, b=num&255;
    return `rgba(${r},${g},${b},${alpha})`;
}

let animatingEffects = false;
function startEffectsLoop() {
    if (animatingEffects) return; animatingEffects = true;
    function step(){
        // Quick check: any pixel with effect?
        let has = false; for (const p of pixelData.values()) { if (p.effect) { has = true; break; } }
        if (has) renderCanvas();
        requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}
if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', startEffectsLoop); } else { startEffectsLoop(); }

// ================== Admin Panel Logic ==================
function openAdminPanel(){
    const panel = document.getElementById('adminPanel');
    if(panel) panel.style.display='block';
    // load data
    adminLoadItems();
    adminLoadBoxes();
    // Show default tab (items)
    document.querySelectorAll('#adminPanel .admin-tab').forEach(t=>t.style.display='none');
    const def = document.getElementById('adminItems'); if(def) def.style.display='block';
    document.querySelectorAll('#adminPanel .admin-tab-link').forEach(b=>b.classList.remove('active'));
    const firstBtn = document.querySelector('#adminPanel .admin-tab-link[data-target="adminItems"]'); if(firstBtn) firstBtn.classList.add('active');
}
function adminBind(){
    document.querySelectorAll('.admin-tab-link').forEach(btn=>{
        btn.addEventListener('click', ()=>{
            const target = btn.getAttribute('data-target');
            document.querySelectorAll('.admin-tab').forEach(t=>t.style.display='none');
            const el = document.getElementById(target); if(el) el.style.display='block';
            document.querySelectorAll('.admin-tab-link').forEach(b=>b.classList.remove('active'));
            btn.classList.add('active');
        });
    });
    const itemForm = document.getElementById('adminItemForm');
    // legacy itemForm removed
    const boxForm = document.getElementById('adminBoxForm');
    // legacy boxForm removed
    const btnExport = document.getElementById('btnExportLoot');
    if(btnExport){
        btnExport.addEventListener('click', async ()=>{
            const r = await fetch('/api/loot/admin/export',{headers:{'Authorization':`Bearer ${authToken}`}});
            if(r.ok){ const data = await r.json(); document.getElementById('lootExportArea').value = JSON.stringify(data, null, 2); }
        });
    }
    const btnImport = document.getElementById('btnImportLoot');
    if(btnImport){
        btnImport.addEventListener('click', async ()=>{
            const txt = document.getElementById('lootImportArea').value;
            try{
                const parsed = JSON.parse(txt);
                const r = await fetch('/api/loot/admin/import',{method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${authToken}`}, body: JSON.stringify(parsed)});
                const status = document.getElementById('lootImportStatus');
                if(r.ok){ const data = await r.json(); status.textContent = `Imported items:${data.imported_items} boxes:${data.imported_boxes}`; adminLoadItems(); adminLoadBoxes(); }
                else status.textContent = 'Import failed';
            }catch(e){ document.getElementById('lootImportStatus').textContent = 'Invalid JSON'; }
        });
    }
}
function adminLoadItems(){
    fetch('/api/items', {headers:{'Authorization':`Bearer ${authToken}`}}).then(r=>r.json()).then(data=>{
        const list = document.getElementById('adminItemsList'); if(!list) return; list.innerHTML='';
    window._adminItemsCache = data.items || [];
        (data.items||[]).forEach(it=>{
            const row = document.createElement('div'); row.className='admin-row';
            row.innerHTML = `<code>${it.id}</code> <span>${it.name}</span> <small>${it.type}/${it.rarity}</small> ${it.payload?.color?`<span style='background:${it.payload.color};display:inline-block;width:16px;height:16px;border:1px solid #000;'></span>`:''} <button class='mini' data-act='edit'>Edit</button> <button class='mini danger' data-act='del'>Del</button>`;
            row.querySelector('[data-act="del"]').addEventListener('click', async ()=>{ if(confirm('Delete item?')){ const r= await fetch('/api/loot/admin/item/'+it.id,{method:'DELETE', headers:{'Authorization':`Bearer ${authToken}`}}); if(r.ok) adminLoadItems(); }});
            row.querySelector('[data-act="edit"]').addEventListener('click', ()=> openLootEditor('item', it));
            list.appendChild(row);
        });
    });
}
function adminLoadBoxes(){
    fetch('/api/loot/boxes', {headers:{'Authorization':`Bearer ${authToken}`}}).then(r=>r.json()).then(data=>{
        const list = document.getElementById('adminBoxesList'); if(!list) return; list.innerHTML='';
        (data.boxes||[]).forEach(b=>{
            const row = document.createElement('div'); row.className='admin-row';
            row.innerHTML = `<code>${b.id}</code> <span>${b.name}</span> <small>${b.price_coins}c</small> <button class='mini' data-act='edit'>Edit</button> <button class='mini danger' data-act='del'>Del</button>`;
            row.querySelector('[data-act="del"]').addEventListener('click', async ()=>{ if(confirm('Delete box?')){ const r= await fetch('/api/loot/admin/box/'+b.id,{method:'DELETE', headers:{'Authorization':`Bearer ${authToken}`}}); if(r.ok) adminLoadBoxes(); }});
            row.querySelector('[data-act="edit"]').addEventListener('click', ()=> openLootEditor('box', b));
            list.appendChild(row);
        });
    });
}
if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded', adminBind);} else { adminBind(); }

// ================== Loot Editor Modal (Items / Boxes) ==================
let rarityTiers = [
    {key:'common', label:'Common', color:'#b0b0b0', weight:60},
    {key:'rare', label:'Rare', color:'#4d7dff', weight:25},
    {key:'epic', label:'Epic', color:'#b24dff', weight:12},
    {key:'legendary', label:'Legendary', color:'#ffae00', weight:3},
];

async function loadServerTiers(){
    try{
        const r = await fetch('/api/tiers');
        if(r.ok){ const data = await r.json(); if(Array.isArray(data.tiers) && data.tiers.length){ rarityTiers = data.tiers; populateRaritySelect(); } }
    }catch(_){ /* ignore */ }
}
loadServerTiers();

function openLootEditor(mode='item', existing=null){
    const modal = document.getElementById('lootEditorModal'); if(!modal) return; modal.style.display='block';
    document.getElementById('lootEditorMode').value = mode;
    document.getElementById('lootEditorTitle').textContent = existing? (mode==='item'? 'Edit Item':'Edit Box') : (mode==='item'? 'New Item':'New Box');
    const form = document.getElementById('lootEditorForm'); form.reset();
    populateRaritySelect();
    lootEditorTypeChanged();
    toggleBoxFields(mode==='box');
    if(existing){ fillLootEditor(existing); }
    updateLootPreview();
}
function closeLootEditor(){ const modal = document.getElementById('lootEditorModal'); if(modal) modal.style.display='none'; }
function switchLootEditorMode(){
    const current = document.getElementById('lootEditorMode').value;
    const next = current==='item' ? 'box' : 'item';
    openLootEditor(next);
}
function populateRaritySelect(){
    const sel = document.getElementById('lootRaritySelect'); if(!sel) return; sel.innerHTML='';
    rarityTiers.forEach(t=>{ const opt=document.createElement('option'); opt.value=t.key; opt.textContent=t.label; sel.appendChild(opt); });
}
function fillLootEditor(obj){
    const form = document.getElementById('lootEditorForm'); if(!form) return;
    // base fields
    ['id','name','price_coins','max_rolls'].forEach(k=>{ if(obj[k]!==undefined){ const f=form.querySelector(`[name="${k}"]`); if(f) f.value=obj[k]; }});
    if(obj.payload){
        if(obj.payload.color){ form.querySelector('[name="payload.color"]').value = obj.payload.color; }
        if(obj.payload.effect){ form.querySelector('[name="payload.effect"]').value = obj.payload.effect; }
        if(obj.payload.max_pixel_bag_delta){ form.querySelector('[name="payload.max_pixel_bag_delta"]').value = obj.payload.max_pixel_bag_delta; }
        if(obj.payload.coins){ form.querySelector('[name="payload.coins"]').value = obj.payload.coins; }
    }
    if(obj.tags){ form.querySelector('[name="tags"]').value = obj.tags.join(', '); }
    if(obj.type){ form.querySelector('[name="type"]').value = obj.type; }
    if(obj.guaranteed){ form.querySelector('[name="guaranteed"]').value = obj.guaranteed.join(','); }
    if(obj.rarity_bonus){ form.querySelector('[name="rarity_bonus"]').value = JSON.stringify(obj.rarity_bonus); }
    if(obj.drops){
        clearDropRows();
        obj.drops.forEach(d=> addDropRow(d.item_id, d.weight));
    } else clearDropRows();
    lootEditorTypeChanged();
    toggleBoxFields(document.getElementById('lootEditorMode').value==='box');
}
function lootEditorTypeChanged(){
    const type = document.getElementById('lootTypeSelect')?.value;
    document.querySelectorAll('.conditional').forEach(el=>el.style.display='none');
    if(type){ const block = document.querySelector('.field-'+type); if(block) block.style.display='block'; }
    updateLootPreview();
}
function toggleBoxFields(show){
    document.querySelectorAll('.box-only').forEach(el=> el.style.display = show? 'block':'none');
    document.getElementById('fieldTypeWrapper').style.display = show? 'none':'block';
    document.getElementById('lootRaritySelect').disabled = show; // boxes don't use rarity directly
    document.getElementById('switchModeBtn').textContent = show? 'Switch to Item':'Switch to Box';
}
function gatherLootEditorData(){
    const form = document.getElementById('lootEditorForm'); const mode = document.getElementById('lootEditorMode').value;
    const fd = new FormData(form);
    if(mode==='item'){
        const payload = {};
        const color = fd.get('payload.color'); if(color) payload.color = color;
        const effect = fd.get('payload.effect'); if(effect) payload.effect = effect;
        const bag = fd.get('payload.max_pixel_bag_delta'); if(bag) payload.max_pixel_bag_delta = parseInt(bag);
        const coins = fd.get('payload.coins'); if(coins) payload.coins = parseInt(coins);
        return {
            endpoint: '/api/loot/admin/item/upsert',
            body: {
                id: fd.get('id'),
                type: fd.get('type'),
                name: fd.get('name'),
                rarity: fd.get('rarity'),
                payload,
                tags: (fd.get('tags')||'').split(',').map(t=>t.trim()).filter(Boolean)
            }
        };
    } else { // box
        const guaranteed = (fd.get('guaranteed')||'').split(',').map(s=>s.trim()).filter(Boolean);
        let rarity_bonus={}; try { rarity_bonus = JSON.parse(fd.get('rarity_bonus')||'{}'); } catch(_){ }
        return {
            endpoint: '/api/loot/admin/box/upsert',
            body: {
                id: fd.get('id'),
                name: fd.get('name'),
                price_coins: parseInt(fd.get('price_coins')||'0'),
                drops: collectDropRows(),
                guaranteed,
                rarity_bonus,
                max_rolls: parseInt(fd.get('max_rolls')||'1')
            }
        };
    }
}
function rarityMeta(key){ return rarityTiers.find(r=>r.key===key) || {color:'#999', label:key}; }
function updateLootPreview(){
    const card = document.getElementById('lootPreviewCard'); if(!card) return;
    const mode = document.getElementById('lootEditorMode').value;
    const type = document.getElementById('lootTypeSelect')?.value;
    const name = document.querySelector('#lootEditorForm [name="name"]').value || '(name)';
    const rarity = document.querySelector('#lootEditorForm [name="rarity"]').value;
    const rarityInfo = rarityMeta(rarity);
    let inner = '';
    if(mode==='item'){
        if(type==='color'){
            const col = document.querySelector('[name="payload.color"]').value || '#888888';
            const eff = document.querySelector('[name="payload.effect"]').value;
            inner = `<div class='preview-swatch' style='background:${col}; box-shadow:${eff==='glow'?`0 0 8px ${col}`:'none'}'></div>`;
            if(eff==='spark') inner += `<div class='preview-spark'>✦</div>`;
        } else if(type==='upgrade'){
            const bag = document.querySelector('[name="payload.max_pixel_bag_delta"]').value || '0';
            inner = `<div class='preview-upgrade'>Bag +${bag}</div>`;
        } else if(type==='effect'){
            const eff = document.querySelector('[name="payload.effect"]').value || 'effect';
            inner = `<div class='preview-effect-tag'>${eff}</div>`;
        } else if(type==='currency_pack'){
            const coins = document.querySelector('[name="payload.coins"]').value || '0';
            inner = `<div class='preview-currency'>${coins} <span class='material-symbols-rounded' style='font-size:16px;vertical-align:middle;'>paid</span></div>`;
        }
        card.innerHTML = `<div class='loot-preview-top' style='border-color:${rarityInfo.color}'><span class='rarity-tag' style='background:${rarityInfo.color}'>${rarityInfo.label}</span><strong>${name}</strong></div><div class='loot-preview-body'>${inner}</div>`;
    } else {
    const price = document.querySelector('[name="price_coins"]').value || '0';
    const drops = collectDropRows();
    const dropList = drops.slice(0,5).map(d=>`<li>${d.item_id}<small>x${d.weight}</small></li>`).join('') + (drops.length>5?'<li>...</li>':'');
    card.innerHTML = `<div class='loot-preview-top' style='border-color:#555'><strong>${name}</strong><span class='price-tag'>${price}c</span></div><div class='loot-preview-body'><ul class='mini-drop-list'>${dropList||'<li>(no drops)</li>'}</ul></div>`;
    }
}
document.addEventListener('input', e=>{ if(e.target.closest('#lootEditorForm')) updateLootPreview(); });
document.addEventListener('change', e=>{ if(e.target.closest('#lootEditorForm')) updateLootPreview(); });

// Explicit save handler (no form submit)
async function saveLootEditor(){
    const {endpoint, body} = gatherLootEditorData();
    const mode = document.getElementById('lootEditorMode').value;
    const err = validateLootBody(body, mode);
    if(err){ alert('Validation: '+err); return; }
    try {
        const r = await fetch(endpoint,{method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${authToken}`}, body: JSON.stringify(body)});
        if(!r.ok){ const txt = await r.text(); throw new Error(txt||'Save failed'); }
        // refresh lists according to mode
        if(mode==='item'){ adminLoadItems(); } else { adminLoadBoxes(); }
        closeLootEditor();
    } catch(e){
        console.error('Save error', e); alert('Save failed: '+e.message);
    }
}

// Keyboard shortcuts: Ctrl+Alt+I new item, Ctrl+Alt+B new box (when admin modal visible)
document.addEventListener('keydown', e=>{
        if(e.ctrlKey && e.altKey && e.key.toLowerCase()==='i'){ if(document.getElementById('adminModal')?.style.display!=='none') { e.preventDefault(); openLootEditor('item'); } }
        if(e.ctrlKey && e.altKey && e.key.toLowerCase()==='b'){ if(document.getElementById('adminModal')?.style.display!=='none') { e.preventDefault(); openLootEditor('box'); } }
});

// ========== Tier Editor ========== 
function openTierEditor(){
    const modal = document.getElementById('tierEditorModal'); if(!modal) return; modal.style.display='block';
    renderTierRows();
}
function renderTierRows(){
    const tbody = document.querySelector('#tierTable tbody'); if(!tbody) return; tbody.innerHTML='';
    rarityTiers.forEach(t=>{
        const tr = document.createElement('tr');
        tr.dataset.key = t.key;
        tr.innerHTML = `<td>${t.key}</td>`+
            `<td><input value='${t.label}' data-field='label'></td>`+
            `<td><input type='color' value='${t.color}' data-field='color'></td>`+
            `<td><input type='number' min='1' value='${t.weight}' data-field='weight' style='width:70px;'></td>`+
            `<td><button type='button' class='btn small danger' data-act='del-tier' title='Delete'>✕</button></td>`;
        tr.querySelector('[data-act="del-tier"]').addEventListener('click', ()=>{ deleteTier(t.key); });
        tbody.appendChild(tr);
    });
}
function addTier(){
    // Generate a unique key base on pattern tierN
    let i=1; let key;
    do { key = 'tier'+i; i++; } while(rarityTiers.find(t=>t.key===key));
    rarityTiers.push({key, label: key, color: '#888888', weight: 1});
    renderTierRows();
}
function deleteTier(key){
    // Prevent removal if it would leave zero tiers
    if(rarityTiers.length<=1){ alert('At least one tier required'); return; }
    rarityTiers = rarityTiers.filter(t=>t.key!==key);
    renderTierRows();
}
function closeTierEditor(){ const m=document.getElementById('tierEditorModal'); if(m) m.style.display='none'; }
function saveTierConfig(){
    const rows = document.querySelectorAll('#tierTable tbody tr');
    rows.forEach(r=>{
        const key = r.cells[0].textContent.trim();
        const label = r.querySelector('[data-field="label"]').value;
        const color = r.querySelector('[data-field="color"]').value;
        const weight = parseInt(r.querySelector('[data-field="weight"]').value)||1;
        const tier = rarityTiers.find(t=>t.key===key); if(tier){ tier.label=label; tier.color=color; tier.weight=weight; }
    });
    // Persist to server
    fetch('/api/admin/tiers',{method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${authToken}`}, body: JSON.stringify({tiers: rarityTiers})})
        .then(r=>{ if(!r.ok) throw new Error(); return r.json(); })
        .then(()=>{ closeTierEditor(); populateRaritySelect(); updateLootPreview(); })
        .catch(()=>{ alert('Failed to save tiers'); });
}

// ---- Drops Builder Helpers ----
function clearDropRows(){ const c=document.getElementById('dropRows'); if(c) c.innerHTML=''; }
function addDropRow(item_id='', weight=1){
    const c=document.getElementById('dropRows'); if(!c) return;
    const row=document.createElement('div'); row.className='drops-row'; row.setAttribute('role','row');
    // build select options from cached admin items list if present
    const itemOptions = window._adminItemsCache ? window._adminItemsCache.map(it=>`<option value="${it.id}">${it.name||it.id}</option>`).join('') : '';
    row.innerHTML = `<div class='cell'>
        <select class='drop-item-id' aria-label='Item'>
            <option value=''>-- select --</option>
            ${itemOptions}
        </select>
    </div>
    <div class='cell small'><input type='number' min='1' value='${weight}' class='drop-weight' aria-label='Weight'></div>
    <div class='cell small'><div class='percent-badge' data-percent>0%</div></div>
    <div class='cell action'><button type='button' class='mini' data-act='del' aria-label='Delete drop'>&times;</button></div>`;
    const sel = row.querySelector('.drop-item-id'); sel.value = item_id;
    row.querySelector('[data-act="del"]').addEventListener('click', ()=>{ row.remove(); updateDropsPercentages(); updateLootPreview(); });
    row.querySelector('.drop-weight').addEventListener('input', ()=>{ updateDropsPercentages(); updateLootPreview(); });
    row.querySelector('.drop-item-id').addEventListener('change', ()=>{ updateLootPreview(); });
    c.appendChild(row);
    updateDropsPercentages();
    updateLootPreview();
}
function updateDropsPercentages(){
    const rows = document.querySelectorAll('#dropRows .drops-row');
    let total = 0; rows.forEach(r=>{ const w=parseInt(r.querySelector('.drop-weight').value)||0; total += w; });
    rows.forEach(r=>{ const w=parseInt(r.querySelector('.drop-weight').value)||0; const pct = total? ((w/total)*100).toFixed(1):'0.0'; const badge=r.querySelector('[data-percent]'); if(badge) badge.textContent = pct+'%'; });
}
function collectDropRows(){
    const rows = document.querySelectorAll('#dropRows .drops-row');
    return Array.from(rows).map(r=>({
        item_id: r.querySelector('.drop-item-id').value.trim(),
        weight: parseInt(r.querySelector('.drop-weight').value)||1
    })).filter(d=>d.item_id);
}

function validateLootBody(body, mode){
    if(mode==='item'){
        if(!body.id || !body.name) return 'id/name required';
        if(body.type==='color'){
            const c = body.payload.color||''; if(!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) return 'Invalid color hex';
        }
        if(body.type==='upgrade'){
            if(!body.payload.max_pixel_bag_delta || body.payload.max_pixel_bag_delta < 1) return 'Upgrade delta must be >=1';
        }
    } else {
        if(!body.id || !body.name) return 'id/name required';
        if(body.price_coins < 0) return 'price_coins >=0';
        if(!body.drops.length) return 'At least one drop';
        for(const d of body.drops){ if(d.weight <=0) return 'Drop weights >0'; }
    }
    return null;
}

function updateUserCount(count) {
    userCount = count;
// (Removed legacy admin panel logic; unified implementation below)
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
    console.log('Canvas click event fired');

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
    if (!panel) return;
    panel.classList.toggle('minimized');
    const btn = panel.querySelector('.minimize-btn');
    if (btn) btn.textContent = panel.classList.contains('minimized') ? '+' : '−';
    panel.setAttribute('aria-expanded', (!panel.classList.contains('minimized')).toString());
}

// New chat shell toggle
function toggleChatShell() {
    const shell = document.getElementById('chatPanel');
    if (!shell) return;
    const minimized = shell.classList.toggle('minimized');
    shell.setAttribute('aria-expanded', (!minimized).toString());
    if (!minimized) {
        // reset unread badge
        const badge = document.getElementById('chatUnreadBadge');
        if (badge) { badge.style.display='none'; badge.textContent='0'; }
        // auto-scroll
        const msgs = document.getElementById('chatMessages');
        if (msgs) msgs.scrollTop = msgs.scrollHeight;
    }
    const chevron = document.getElementById('chatChevron');
    if (chevron) chevron.textContent = minimized ? 'expand_more' : 'expand_less';
}

// Hook into message append to increment unread if minimized
function appendChatMessageElement(el) {
    const shell = document.getElementById('chatPanel');
    const msgs = document.getElementById('chatMessages');
    if (!msgs) return;
    msgs.appendChild(el);
    const nearBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 32;
    if (shell && !shell.classList.contains('minimized') && nearBottom) {
        msgs.scrollTop = msgs.scrollHeight;
    } else if (shell && shell.classList.contains('minimized')) {
        const badge = document.getElementById('chatUnreadBadge');
        if (badge) {
            let v = parseInt(badge.textContent || '0', 10) || 0;
            v += 1;
            badge.textContent = String(v);
            badge.style.display = 'inline-flex';
        }
    }
}

function pulseConnectionIndicator() {
    const indicator = document.getElementById('connectionIndicator');
    if (!indicator) return;
    indicator.classList.add('pulse-event');
    setTimeout(() => { if(indicator) indicator.classList.remove('pulse-event'); }, 600);
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
    const el = document.getElementById('pingDisplay');
    if (el) el.textContent = ping + 'ms';
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
    console.log('Click detected - placing pixel');
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
    console.warn('🚫 Blocked pixel placement locally: pixel bag empty (0).');
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
    // Ignore if focused on any text input/textarea/contenteditable element
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) {
        return;
    }
    // Specific legacy chat input check (kept for safety)
    const chatInput = document.getElementById('chatInput');
    if (document.activeElement === chatInput) return;

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
                <span class="material-symbols-rounded" style="font-size: 20px; animation: bounce 0.6s ease-in-out;">palette</span>
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
                        <span class="material-symbols-rounded" style="font-size: 20px; animation: bounce 1s infinite;">bolt</span>
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
    
    console.log(`Preview: adding pixel at ${x},${y} (${bulkPreviewPixels.size} total preview)`);
    
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
    
    // Throttled indicator update to reduce DOM churn
    const now2 = Date.now();
    if (now2 - lastBulkIndicatorUpdate > BULK_INDICATOR_UPDATE_MS) {
        lastBulkIndicatorUpdate = now2;
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
                    <span class="material-symbols-rounded" style="font-size: 20px; animation: bounce 0.6s ease-in-out;">palette</span>
                    <div>
                        <div style="font-weight: bold;">BULK PAINT MODE</div>
                        <div style="font-size: 11px; opacity: 0.9;">${statusText}</div>
                    </div>
                    <span id="bulkCounter" style="background: ${bulkCounter ? bulkCounter.style.background : 'rgba(255,255,255,0.2)'}; padding: 2px 6px; border-radius: 10px; font-size: 12px; transition: all 0.3s ease;">${previewCount}</span>
                </div>
            `;
        }
    }
    // Schedule batched render
    scheduleRender();
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
    achievementCountChanged();
    }
}

function addChatMessage(userId, message, timestamp, userData = null, scroll = true) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'chat-message';

    // Username + optional level badge, clickable
    let levelBadge = '';
    let roleClass = '';
    let displayName = userId;
    let chatColor = '#55aaff';
    if (userData) {
        if (userData.level) levelBadge = `<span class="user-level-badge level-${userData.level}">Lv.${userData.level}</span>`;
        if ((userData.role || '').toLowerCase() === 'admin') roleClass = 'admin-user';
        displayName = userData.display_name || userData.username || userId;
        chatColor = userData.chat_color || chatColor;
    }
    const safeMsg = escapeHtml(message);
    messageDiv.innerHTML = `
        ${levelBadge}<button class="chat-username-btn ${roleClass}" style="color:${chatColor}" data-username="${userId}">${displayName}</button>
        <span class="chat-sep">:</span>
        <span class="chat-text">${safeMsg}</span>
    `;
    // Attach click handler for profile
    const btn = messageDiv.querySelector('.chat-username-btn');
    if (btn) {
        btn.addEventListener('click', () => openUserProfile(userId));
    }
    appendChatMessageElement(messageDiv);
}

async function openUserProfile(username) {
    try {
        const res = await fetch(`/api/profile/${encodeURIComponent(username)}`);
        if (!res.ok) return;
        const data = await res.json();
        showUserProfileModal(data);
    } catch (e) { console.error('Profile load failed', e); }
}

function showUserProfileModal(data) {
    let modal = document.getElementById('userProfileModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'userProfileModal';
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal glass-readable profile-modal">
                <div class="modal-header"><h3 id="profileTitle">User</h3><button class="close-btn" id="closeProfileBtn">×</button></div>
                <div class="modal-body" id="profileBody"></div>
            </div>`;
        document.body.appendChild(modal);
        modal.addEventListener('click', (e)=>{ if(e.target===modal) closeProfileModal(); });
        modal.querySelector('#closeProfileBtn').addEventListener('click', closeProfileModal);
    }
    const body = modal.querySelector('#profileBody');
    const title = modal.querySelector('#profileTitle');
    if (title) title.textContent = data.username + ' Profile';
    if (body) {
        body.innerHTML = `
            <div class="profile-stats">
                <div><strong>Level:</strong> ${data.level}</div>
                <div><strong>Pixels:</strong> ${data.pixels}</div>
                <div><strong>Messages:</strong> ${data.messages}</div>
                <div><strong>Achievements:</strong> ${data.achievements}</div>
                <div><strong>Coins:</strong> ${data.coins}</div>
            </div>`;
    }
    modal.style.display = 'flex';
}

function closeProfileModal(){
    const modal = document.getElementById('userProfileModal');
    if (modal) modal.style.display='none';
}

function addSystemMessage(message) {
    const chatMessages = document.getElementById('chatMessages');
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message system';
    messageDiv.textContent = message;

    appendChatMessageElement(messageDiv);
}

function updateStatus(message, statusType = 'connecting') {
    const indicator = document.getElementById('connectionIndicator');
    const statusTextEl = document.getElementById('connectionStatusText');
    if (indicator) {
        indicator.className = 'status-indicator';
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
    }
    if (statusTextEl) statusTextEl.textContent = message;
    console.log('Connection status:', message);
}

// ==================== RANKINGS UI ====================
function openRankings() {
    const modal = document.getElementById('rankingsModal');
    if (!modal) return;
    modal.classList.add('show');
    loadRanking('pixels');
}
function closeRankings() {
    const modal = document.getElementById('rankingsModal');
    if (modal) modal.classList.remove('show');
}
function switchRankingTab(btn, type) {
    document.querySelectorAll('.ranking-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const body = document.getElementById('rankingsBody');
    if (body) {
        body.classList.remove('fade-in');
        body.classList.add('fade-out');
        setTimeout(() => { loadRanking(type); }, 180);
    } else {
        loadRanking(type);
    }
}
async function loadRanking(type) {
    const body = document.getElementById('rankingsBody');
    const headerMetric = document.getElementById('metricHeader');
    const foot = document.getElementById('rankingFootnote');
    if (body) body.innerHTML = '<tr><td colspan="5" style="text-align:center; opacity:.6;">Loading...</td></tr>';
    if (headerMetric) headerMetric.textContent = type.charAt(0).toUpperCase() + type.slice(1);
    try {
        const resp = await fetch(`/api/rankings?rtype=${encodeURIComponent(type)}`, { headers: { 'Authorization': `Bearer ${authToken}` }});
        if (!resp.ok) throw new Error('Failed');
        const data = await resp.json();
        if (body) {
            body.innerHTML = '';
            if (data.results.length === 0) {
                body.innerHTML = '<tr><td colspan="5" style="text-align:center; opacity:.6;">No data</td></tr>';
            } else {
                data.results.forEach(row => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td><span class="rank-badge">#${row.rank}</span></td>
                        <td>${escapeHtml(row.username)}</td>
                        <td>${row.value}</td>
                        <td>${row.level}</td>
                        <td>${row.achievements}</td>
                    `;
                    body.appendChild(tr);
                });
            }
        }
        if (foot) foot.textContent = `Type: ${data.type} • Showing top ${data.results.length}`;
        if (body) {
            body.classList.remove('fade-out');
            // Force reflow for animation restart
            void body.offsetWidth;
            body.classList.add('fade-in');
        }
    } catch (e) {
        if (body) body.innerHTML = '<tr><td colspan="5" style="text-align:center; color:#ef4444;">Error loading rankings</td></tr>';
    }
}

// Update mini status indicators in navbar
function updateMiniStatus() {
    const uc = document.getElementById('userCountMini');
    const pingEl = document.getElementById('pingMini');
    if (uc) uc.textContent = `${userCount} online`;
    if (pingEl) pingEl.textContent = `${ping}ms`;
}
setInterval(updateMiniStatus, 2000);

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

// ==================== ECONOMY & LOOT ====================
function updateEconomyFromPayload(p) {
    if (!p) return;
    if (typeof p.coins === 'number') {
        const coinEl = document.getElementById('coinBalance');
        if (coinEl) coinEl.textContent = p.coins;
    }
    const level = p.user_level ?? p.level;
    if (typeof level === 'number') {
        const lvlBadge = document.getElementById('levelBadge');
        if (lvlBadge) lvlBadge.textContent = `Lv.${level}`;
    }
    if (typeof p.experience_points === 'number' && typeof p.xp_to_next === 'number') {
        const xpFill = document.getElementById('xpFill');
        const xpText = document.getElementById('xpText');
        const cur = p.experience_points;
        const toNext = p.xp_to_next || 1;
        const pct = Math.min(100, (cur / toNext) * 100);
        if (xpFill) xpFill.style.width = pct + '%';
        if (xpText) xpText.textContent = `${cur}/${toNext}`;
    }
}

function openLootBoxesModal() {
    const modal = document.getElementById('lootModal');
    if (!modal) return;
    modal.style.display = 'flex';
    loadLootBoxes();
}
function closeLootBoxesModal() {
    const modal = document.getElementById('lootModal');
    if (modal) modal.style.display = 'none';
}

async function loadLootBoxes() {
    const list = document.getElementById('lootBoxesList');
    if (!list) return;
    list.innerHTML = 'Loading...';
    try {
        const r = await fetch('/api/loot/boxes');
        const data = await r.json();
        const boxes = data.boxes || [];
        if (!boxes.length) { list.innerHTML = '<div style="opacity:.6;">No boxes</div>'; return; }
        list.innerHTML = '';
        boxes.forEach(b => {
            const div = document.createElement('div');
            div.className = 'loot-box-card';
            div.innerHTML = `
                <h4>${escapeHtml(b.name)}</h4>
                <div class="price"><span class="material-symbols-rounded" style="font-size:16px;">paid</span>${b.price_coins}</div>
                <div class="drops" style="font-size:11px; line-height:1.3; max-height:60px; overflow:auto;">
                    ${(b.drops||[]).slice(0,8).map(d=>escapeHtml(d.item_id)).join(', ')}${(b.drops||[]).length>8?'…':''}
                </div>
                <button onclick="openLootBox('${b.id}', this)">Open</button>
            `;
            list.appendChild(div);
        });
    } catch(e) {
        list.innerHTML = '<div style="color:#ef4444;">Failed to load boxes</div>';
    }
}

async function openLootBox(boxId, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Opening...'; }
    const resultEl = document.getElementById('lootResult');
    if (resultEl) { resultEl.style.display='block'; resultEl.innerHTML = 'Opening...'; }
    try {
        const r = await fetch('/api/loot/open', { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${authToken}`}, body: JSON.stringify({ box_id: boxId }) });
        if (!r.ok) {
            const err = await r.json();
            throw new Error(err.detail || 'Open failed');
        }
        const data = await r.json();
        updateEconomyFromPayload(data);
        const awarded = [...(data.guaranteed||[]), ...(data.awarded||[])];
        let cards = awarded.map(it => {
            const r = String(it.rarity||'common').toLowerCase();
            const bgClass = `rarity-${r}-bg`;
            const textClass = `rarity-${r}`;
            return `<div class="loot-card ${bgClass}" style="padding:10px 12px; border-radius:14px; position:relative; display:flex; flex-direction:column; gap:4px; box-shadow:0 4px 18px -4px rgba(0,0,0,.6);">
                <span class="loot-item-name ${textClass}" style="font-weight:600; font-size:14px;">${escapeHtml(it.name||it.item_id)}</span>
                <span style="font-size:11px; opacity:.75; letter-spacing:.5px;">${r.toUpperCase()}</span>
            </div>`;
        }).join('');
        if (!cards) cards = '<div style="opacity:.6;">Nothing?</div>';
        if (resultEl) {
            resultEl.classList.add('loot-opening-animation');
            resultEl.innerHTML = `
                <div style="display:flex; flex-wrap:wrap; gap:10px;">${cards}</div>
                <div style="margin-top:10px; font-size:11px; opacity:.7;">Coins left: ${data.coins}</div>`;
            setTimeout(()=>resultEl.classList.remove('loot-opening-animation'), 2200);
        }
        flashEconomyBar();
        // Duplicate compensation toasts
        awarded.forEach(it => {
            if (it.duplicate && it.compensation_coins) {
                addSystemMessage(`💱 Duplicate ${it.name||it.item_id}: +${it.compensation_coins} coins`);
            }
        });
        // Refresh palette with any newly unlocked colors (post-auth only)
        if (typeof loadOwnedColors === 'function') {
            try { loadOwnedColors(); } catch(_){}
        }
    } catch(e) {
        if (resultEl) resultEl.innerHTML = `<span style='color:#f87171;'>${escapeHtml(e.message)}</span>`;
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Open'; }
    }
}

function flashEconomyBar() {
    const bar = document.getElementById('economySidebar');
    if (!bar) return;
    bar.style.transition = 'box-shadow .4s';
    const orig = bar.style.boxShadow || '';
    bar.style.boxShadow = '0 0 0 3px rgba(255,255,255,0.4),0 4px 20px -4px rgba(0,0,0,0.4)';
    setTimeout(()=>{ if(bar) bar.style.boxShadow=orig; }, 450);
}

function handleNewItemUnlocked(data) {
    // Show toast for rare unlocks
    const container = document.getElementById('achievementToasts');
    if (!container || !data.item) return;
    const t = document.createElement('div');
    const rarity = (data.item.rarity||'').toLowerCase();
    t.className = `item-unlock-toast ${rarity}`;
    t.innerHTML = `<strong>${escapeHtml(data.user_id)}</strong> unlocked <span class='rarity-${rarity}'>${escapeHtml(data.item.name||data.item.item_id)}</span>`;
    container.appendChild(t);
    setTimeout(()=>{ if(t.parentNode) t.remove(); }, 6000);
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

    // Stop reward scale interval
    if (rewardScaleIntervalId){
        clearInterval(rewardScaleIntervalId);
        rewardScaleIntervalId = null;
    }
    
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

                // Start reward scale polling (once) after auth
                if (!rewardScaleIntervalId){
                    updateRewardScaleIndicator(); // immediate first fetch
                    rewardScaleIntervalId = setInterval(updateRewardScaleIndicator, 3500);
                }

                // Load owned colors now that we're authenticated (if function exists & palette empty)
                if (typeof loadOwnedColors === 'function'){
                    try { loadOwnedColors(); } catch(e){ console.warn('Owned colors load failed:', e); }
                }
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
    const overlay = document.getElementById('adminModal');
    overlay.style.display = 'flex';
    overlay.classList.add('visible');
    // Default to users
    switchAdminSection(document.querySelector('.admin-nav .admin-tab[data-target="usersTab"]'));
    await refreshUsers();
}

function closeAdminPanel() {
    const overlay = document.getElementById('adminModal');
    overlay.style.display = 'none';
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
    document.getElementById('achievementsAdminTab').style.display = 'none';
    document.querySelectorAll('.admin-tab').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.admin-tab')[1].classList.add('active');
    loadStats();
}

function showAchievementsAdminTab() {
    document.getElementById('usersTab').style.display = 'none';
    document.getElementById('statsTab').style.display = 'none';
    document.getElementById('achievementsAdminTab').style.display = 'block';
    document.querySelectorAll('.admin-tab').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.admin-tab')[2].classList.add('active');
    refreshAchievementDefs();
}

// New unified switching
function switchAdminSection(btn) {
    if (!btn) return;
    const targetId = btn.getAttribute('data-target');
    document.querySelectorAll('.admin-nav .admin-tab').forEach(t=>t.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.admin-section').forEach(sec => {
        if (sec.id === targetId) sec.classList.add('active'); else sec.classList.remove('active');
    });
    switch(targetId){
        case 'usersTab':
            refreshUsers();
            break;
        case 'statsTab':
            loadStats();
            break;
        case 'achievementsAdminTab':
            refreshAchievementDefs();
            break;
        case 'lootAdminTab':
            // Ensure sub-pane lists are loaded
            adminLoadItems();
            adminLoadBoxes();
            break;
    }
}

function lootSubSwitch(btn){
    const target = btn.getAttribute('data-target');
    btn.parentNode.querySelectorAll('.loot-subtab').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    const paneContainer = document.querySelector('.loot-subpanes');
    if(!paneContainer) return;
    paneContainer.querySelectorAll('.loot-pane').forEach(p=>p.style.display = (p.id===target)?'block':'none');
    if(target==='adminItems') adminLoadItems();
    if(target==='adminBoxes') adminLoadBoxes();
}

async function refreshAchievementDefs() {
    const list = document.getElementById('achievementDefsList');
    list.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const r = await fetch('/api/achievements/config');
        const data = await r.json();
        const defs = data.achievements || [];
        if (!defs.length) { list.innerHTML = '<div class="empty">No achievements</div>'; return; }
        list.innerHTML = '';
        defs.forEach(d => {
            const card = document.createElement('div');
            card.className = 'ach-card';
            card.innerHTML = `
                <div class="ach-main">
                    <span class="ach-icon">${d.icon}</span>
                    <div class="ach-text">
                        <div class="ach-name">${d.name} <span class="ach-id">(${d.id})</span></div>
                        <div class="ach-desc">${d.desc}</div>
                        <div class="ach-cond">${d.condition.type} ≥ ${d.condition.value} ${d.tier ? '• '+d.tier : ''}</div>
                    </div>
                </div>
                <div class="ach-actions">
                    <button onclick="editAchievementDef('${d.id}')" class="mini-btn">Edit</button>
                    <button onclick="deleteAchievementDef('${d.id}')" class="mini-btn danger">Del</button>
                </div>`;
            list.appendChild(card);
        });
    } catch(e) { list.innerHTML = '<div class="error">Error loading</div>'; }
}

function openNewAchievementForm() {
    document.getElementById('achievementEditor').style.display='block';
    document.getElementById('achEditorTitle').textContent='New Achievement';
    ['achId','achIcon','achName','achTier','achDesc','achCondValue'].forEach(id => { const el=document.getElementById(id); if(el) el.value = (id==='achCondValue'?1:''); });
    document.getElementById('achCondType').value='pixels';
}
function closeAchievementEditor(){ document.getElementById('achievementEditor').style.display='none'; }

async function editAchievementDef(id){
    const r = await fetch('/api/achievements/config');
    const data = await r.json();
    const d = (data.achievements||[]).find(a=>a.id===id); if(!d) return;
    openNewAchievementForm();
    document.getElementById('achEditorTitle').textContent='Edit Achievement';
    document.getElementById('achId').value = d.id;
    document.getElementById('achId').readOnly = true;
    document.getElementById('achIcon').value = d.icon;
    document.getElementById('achName').value = d.name;
    document.getElementById('achTier').value = d.tier || '';
    document.getElementById('achDesc').value = d.desc;
    document.getElementById('achCondType').value = d.condition.type;
    document.getElementById('achCondValue').value = d.condition.value;
}

async function saveAchievementDef(){
    const payload = {
        id: document.getElementById('achId').value.trim(),
    icon: normalizeAchievementIcon(document.getElementById('achIcon').value.trim()) || 'emoji_events',
        name: document.getElementById('achName').value.trim(),
        desc: document.getElementById('achDesc').value.trim(),
        tier: document.getElementById('achTier').value.trim() || null,
        condition: { type: document.getElementById('achCondType').value, value: parseInt(document.getElementById('achCondValue').value,10) }
    };
    const res = await fetch('/api/achievements/admin/upsert', { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${authToken}`}, body: JSON.stringify(payload)});
    if(res.ok){ closeAchievementEditor(); refreshAchievementDefs(); loadAchievementsConfig(); } else { alert('Save failed'); }
}
async function deleteAchievementDef(id){ if(!confirm('Delete achievement '+id+'?')) return; const r= await fetch('/api/achievements/admin/'+id,{method:'DELETE', headers:{'Authorization':`Bearer ${authToken}`}}); if(r.ok){ refreshAchievementDefs(); loadAchievementsConfig(); } }

function exportAchievementDefs(){ fetch('/api/achievements/config').then(r=>r.json()).then(d=>{ const blob=new Blob([JSON.stringify(d.achievements||[],null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='achievements_export.json'; a.click(); }); }
function importAchievementDefs(evt){ const file=evt.target.files[0]; if(!file) return; const reader=new FileReader(); reader.onload=async (e)=>{ try { const arr=JSON.parse(e.target.result); const r= await fetch('/api/achievements/admin/import',{method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${authToken}`}, body: JSON.stringify({ achievements: arr, replace:false })}); if(r.ok){ refreshAchievementDefs(); loadAchievementsConfig(); } else alert('Import failed'); } catch(err){ alert('Invalid JSON'); } }; reader.readAsText(file); }

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
     // Defensive defaults to avoid 'undefined' in number inputs
     const pbSize = Number.isFinite(Number(user.pixel_bag_size)) ? user.pixel_bag_size : 0;
     const maxPbSize = Number.isFinite(Number(user.max_pixel_bag_size)) ? user.max_pixel_bag_size : pbSize;
     const xpVal = Number.isFinite(Number(user.experience_points)) ? user.experience_points : 0;
     const lvlVal = Number.isFinite(Number(user.user_level)) ? user.user_level : 1;
     const displayName = (user.display_name && user.display_name.trim()) || user.username;
     const chatColor = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.test(user.chat_color||'') ? user.chat_color : '#55aaff';
        
        userItem.innerHTML = `
            <div class="user-info-admin">
                <div class="user-name-admin">
              ${user.username} 
              <span class="user-level-badge">Level ${lvlVal}</span>
                </div>
                <div class="user-details">
                    Created: ${new Date(user.created_at).toLocaleDateString()}
                    ${user.last_login ? `| Last login: ${new Date(user.last_login).toLocaleDateString()}` : ''}
                    ${banInfo}
                </div>
                <div class="user-stats">
                    <div class="stat-item">
                        <label>Pixels: </label>
               <input type="number" class="admin-input" value="${pbSize}" 
                   onchange="updateUserData('${user.username}', 'pixel_bag_size', this.value)">
                        /
               <input type="number" class="admin-input" value="${maxPbSize}" 
                   onchange="updateUserData('${user.username}', 'max_pixel_bag_size', this.value)">
                    </div>
                    <div class="stat-item">
                        <label>XP: </label>
               <input type="number" class="admin-input" value="${xpVal}" 
                   onchange="updateUserData('${user.username}', 'experience_points', this.value)">
                    </div>
                    <div class="stat-item">
                        <label>Level: </label>
               <input type="number" class="admin-input" value="${lvlVal}" 
                   onchange="updateUserData('${user.username}', 'user_level', this.value)">
                    </div>
                    <div class="stat-item">
                        <label>Display Name: </label>
               <input type="text" class="admin-input" value="${displayName}" 
                   onchange="updateUserData('${user.username}', 'display_name', this.value)" maxlength="30">
                    </div>
                    <div class="stat-item">
                        <label>Chat Color: </label>
               <input type="color" class="admin-input" value="${chatColor}" 
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
              (typeof currentUser !== 'undefined' && user.username !== currentUser.username ? 
                        `<button class="btn btn-danger" onclick="showBanModal('${user.username}')">Ban</button>` : ''
              )
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
            <span class="material-symbols-rounded" style="font-size: 28px; animation: bounce 0.6s ease-in-out;">celebration</span>
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
    animation: successPop 5s ease-out forwards;
    `;
    document.body.appendChild(successNotification);
    
    // Add success animation styles
    if (!document.getElementById('successAnimations')) {
        const styleSheet = document.createElement('style');
        styleSheet.id = 'successAnimations';
        styleSheet.textContent = `
            @keyframes successPop {
                0% { opacity: 0; transform: translate(-50%, -50%) scale(0); }
                12% { opacity: 1; transform: translate(-50%, -50%) scale(1.08); }
                18% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
                78% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
                100% { opacity: 0; transform: translate(-50%, -50%) scale(0.9); }
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
    }, 6500);
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
    const TOTAL_STEPS = 7;
    if (currentTutorialStep < TOTAL_STEPS) {
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

function goToStep(step) { currentTutorialStep = step; updateTutorialStep(); }

function updateTutorialStep() {
    const TOTAL_STEPS = 7;
    document.querySelectorAll('.tutorial-step').forEach(step => step.classList.remove('active'));
    const cur = document.getElementById(`step${currentTutorialStep}`);
    if (cur) cur.classList.add('active');
    document.querySelectorAll('.dot').forEach((dot, index) => {
        dot.classList.toggle('active', index + 1 === currentTutorialStep);
    });
    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');
    if (prevBtn) prevBtn.disabled = currentTutorialStep === 1;
    if (nextBtn) nextBtn.textContent = currentTutorialStep === TOTAL_STEPS ? 'Finish' : 'Next';
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

// Legacy updateAchievements replaced by new evaluate/render system.
function updateAchievements() { renderAchievementsGrid(); evaluateAndUnlockAchievements(); }

// Track statistics for achievements
let pixelsPlacedCount = 0;
let bulkPlacementsCount = 0;
let chatMessagesCount = 0;
let sessionStartTime = Date.now();

// ==================== ACHIEVEMENTS SYSTEM ====================
// Backend authoritative configuration fetched at runtime
let ACHIEVEMENTS_CONFIG = [];
let achievementsConfigLoaded = false;
// Map legacy emoji to Material Symbols names
const LEGACY_ICON_MAP = {
    '🎯':'my_location', '⚡':'bolt', '💬':'chat', '🎨':'palette', '⏱️':'timer', '💰':'savings', '📅':'calendar_month', '🏆':'emoji_events', '🎉':'celebration'
};
function normalizeAchievementIcon(raw){
    if(!raw) return '';
    if(LEGACY_ICON_MAP[raw]) return LEGACY_ICON_MAP[raw];
    // If user already entered a material symbol name keep it (heuristic: no spaces and length <40)
    if(/^[a-z0-9_]{2,40}$/.test(raw)) return raw;
    return raw; // fallback text (will render as plain)
}
async function loadAchievementsConfig() {
    try {
        const resp = await fetch('/api/achievements/config');
        if (!resp.ok) throw new Error('Failed config fetch');
        const data = await resp.json();
        ACHIEVEMENTS_CONFIG = data.achievements || [];
        achievementsConfigLoaded = true;
        renderAchievementsGrid();
        scheduleAchievementEvaluation();
    } catch (e) {
        console.warn('Failed to load achievements config', e);
    }
}

// Track unlocked achievements in memory + localStorage persistence per user
let unlockedAchievements = new Set();
function loadUnlockedAchievements() {
    if (!currentUsername) return;
    try {
        const raw = localStorage.getItem(`achievements_${currentUsername}`);
        if (raw) {
            unlockedAchievements = new Set(JSON.parse(raw));
        }
    } catch (e) { console.warn('Failed to load achievements', e); }
}
function persistUnlockedAchievements() {
    if (!currentUsername) return;
    try { localStorage.setItem(`achievements_${currentUsername}`, JSON.stringify(Array.from(unlockedAchievements))); } catch (e) {}
}

function evaluateAchievementCondition(cfg) {
    const { type, value } = cfg.condition;
    switch (type) {
        case 'pixels': return pixelsPlacedCount >= value;
        case 'bulk_uses': return bulkPlacementsCount >= value;
        case 'chat_messages': return chatMessagesCount >= value;
        case 'session_minutes': return ((Date.now() - sessionStartTime) / 60000) >= value;
        default:
            if (typeof cfg.condition.predicate === 'function') {
                try { return cfg.condition.predicate(); } catch { return false; }
            }
            return false;
    }
}

function renderAchievementsGrid() {
    const grid = document.getElementById('achievementsGrid');
    if (!grid) return;
    // Only rebuild if counts mismatch
    grid.innerHTML = '';
    ACHIEVEMENTS_CONFIG.forEach(cfg => {
        const unlocked = unlockedAchievements.has(cfg.id) || evaluateAchievementCondition(cfg);
        const div = document.createElement('div');
        div.className = `achievement ${unlocked ? 'unlocked' : 'locked'}`;
        div.dataset.achievementId = cfg.id;
        const iconName = normalizeAchievementIcon(cfg.icon);
        let iconHtml;
        if(iconName && /^[a-z0-9_]{2,40}$/.test(iconName)) {
            iconHtml = `<span class="material-symbols-rounded">${iconName}</span>`;
        } else {
            iconHtml = `<span>${cfg.icon||''}</span>`;
        }
        div.innerHTML = `
            <div class="achievement-icon">${iconHtml}</div>
            <div class="achievement-name">${cfg.name}</div>
            <div class="achievement-desc">${cfg.desc}</div>
        `;
        grid.appendChild(div);
    });
}

function showAchievementToast(cfg) {
    const container = document.getElementById('achievementToasts');
    if (!container) return;
    const toast = document.createElement('div');
    const tierClass = cfg.tier === 'epic' ? 'epic' : (cfg.tier === 'new-tier' ? 'new-tier' : '');
    toast.className = `achievement-toast ${tierClass}`;
    const iconName = normalizeAchievementIcon(cfg.icon);
    const iconHtml = iconName && /^[a-z0-9_]{2,40}$/.test(iconName) ? `<span class="material-symbols-rounded icon-inline">${iconName}</span>` : `<span>${cfg.icon||''}</span>`;
    toast.innerHTML = `
        <h5>${iconHtml} Achievement Unlocked!</h5>
        <p><strong>${cfg.name}</strong><br>${cfg.desc}</p>
        <div class="achievement-progress-bar"><div class="achievement-progress-fill"></div></div>
    `;
    container.appendChild(toast);
    setTimeout(() => {
        if (toast.parentNode) toast.remove();
    }, 7000);
}

let achievementEvaluationScheduled = false;
function scheduleAchievementEvaluation() {
    if (achievementEvaluationScheduled) return;
    achievementEvaluationScheduled = true;
    requestAnimationFrame(() => {
        achievementEvaluationScheduled = false;
        evaluateAndUnlockAchievements();
    });
}

function evaluateAndUnlockAchievements() {
    if (!achievementsConfigLoaded) return;
    // Server authoritative: ask server to evaluate pixel/chat achievements (security)
    // Still do local optimistic evaluation for immediate feedback (e.g., bulk/session) then reconcile.
    let newlyUnlocked = [];
    ACHIEVEMENTS_CONFIG.forEach(cfg => {
        if (!unlockedAchievements.has(cfg.id) && evaluateAchievementCondition(cfg)) {
            unlockedAchievements.add(cfg.id);
            newlyUnlocked.push(cfg);
        }
    });
    if (newlyUnlocked.length > 0) {
        persistUnlockedAchievements();
        renderAchievementsGrid();
        newlyUnlocked.forEach(showAchievementToast);
    }
    if (authToken && currentUsername) {
        // Ask backend to evaluate authoritative unlocks
    fetch('/api/achievements/evaluate', { method: 'POST', headers: { 'Authorization': `Bearer ${authToken}` } })
            .then(r => r.json())
            .then(data => {
                const all = data.all || [];
                let added = [];
                all.forEach(id => {
                    if (!unlockedAchievements.has(id)) {
                        unlockedAchievements.add(id);
                        const cfg = ACHIEVEMENTS_CONFIG.find(c => c.id === id);
                        if (cfg) added.push(cfg);
                    }
                });
                if (added.length) {
                    persistUnlockedAchievements();
                    renderAchievementsGrid();
                    added.forEach(showAchievementToast);
                }
                // Sync sanitized list back (server already validated on evaluate)
                fetch('/api/achievements/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` }, body: JSON.stringify({ achievements: Array.from(unlockedAchievements) }) }).catch(()=>{});
            })
            .catch(()=>{});
    }
}

// Hook into existing counters updates (pixel placement, bulk completion, chat send)
// We already increment counts in pixel_update and bulk_complete handlers.
// After each increment we schedule evaluation (minimal overhead).
// We'll patch those increments below by wrapping increment logic.

// Patch helper: wrap a function to schedule evaluation (if needed later)
function achievementCountChanged() { scheduleAchievementEvaluation(); }

// Periodic evaluation for time-based achievements
setInterval(() => { scheduleAchievementEvaluation(); }, 60000); // every minute

// When user logs in / username set load achievements
// Will be called after auth success externally once username known (add safe polling)
setInterval(() => { if (currentUsername && unlockedAchievements.size === 0) { loadUnlockedAchievements(); renderAchievementsGrid(); scheduleAchievementEvaluation(); } }, 2000);

// Fetch config early
loadAchievementsConfig();

// Optional: expose global stats fetcher for console/testing
window.fetchAchievementDistribution = function() {
    if (!authToken) { console.warn('Not authenticated'); return; }
    fetch('/api/achievements/distribution', { headers: { 'Authorization': `Bearer ${authToken}` }})
        .then(r => r.json())
        .then(d => { console.log('🌐 Achievement Distribution', d); })
        .catch(e => console.error('Failed to load distribution', e));
};

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
// (Ensure all previous blocks closed correctly)
init();
