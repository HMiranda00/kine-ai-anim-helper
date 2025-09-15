// Frontend now calls our backend at /api

// Token helpers removed on frontend; backend holds the token
function getTokenRaw(){ return ''; }
function setTokenRaw(_t){}

async function replicateUpload(file) {
  const form = new FormData();
  form.append('content', file);
  if (!userReplicateToken) { openSettings(); throw new Error('Replicate API key is required'); }
  if (apiMode === 'proxy') {
    const headers = { 'X-Replicate-Token': userReplicateToken };
    const res = await fetch(`${apiBase}/files`, { method: 'POST', headers, body: form });
    if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    return json.urls.get;
  } else {
    const res = await fetch('https://api.replicate.com/v1/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userReplicateToken}` },
      body: form
    });
    if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    return json.urls.get;
  }
}

async function replicateRun(model, input) {
  if (!userReplicateToken) { openSettings(); throw new Error('Replicate API key is required'); }
  if (apiMode === 'proxy') {
    const headers = { 'Content-Type': 'application/json', 'X-Replicate-Token': userReplicateToken };
    const res = await fetch(`${apiBase}/run`, { method: 'POST', headers, body: JSON.stringify({ model, input }) });
    if (!res.ok) throw new Error(await res.text());
    const json = await res.json();
    return json.output;
  } else {
    // Direct mode: create + poll on client
    const create = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${userReplicateToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input })
    });
    const created = await create.json();
    if (!create.ok) throw new Error(created?.error || JSON.stringify(created));
    let url = created?.urls?.get;
    let status = created?.status;
    let last = created;
    const startedAt = Date.now();
    const timeoutMs = 5 * 60 * 1000;
    while (status === 'starting' || status === 'processing') {
      if (Date.now() - startedAt > timeoutMs) throw new Error('Timeout waiting prediction');
      await new Promise(r => setTimeout(r, 1500));
      const r = await fetch(url, { headers: { Authorization: `Bearer ${userReplicateToken}` } });
      last = await r.json();
      status = last.status;
    }
    if (status !== 'succeeded') throw new Error(last?.error || JSON.stringify(last));
    return last.output;
  }
}

// UI State Management
let currentMode = 'image'; // 'image' or 'video'
let promptMode = 'generate'; // 'generate' or 'edit'
let uploadedFiles = []; // Store uploaded file URLs for attachments
let canvasImages = { start: null, end: null }; // Store Replicate URLs for AI
let canvasDisplayImages = { start: null, end: null }; // Store blob URLs for display
let imageHistory = []; // Store generated images for reuse
let activeCanvas = 'start'; // 'start' or 'end' - which canvas is selected
let appState = 'initial'; // 'initial', 'single', 'dual'
let currentVideo = null; // Store current video URL
let lastVideoSize = null; // Store last video player pixel dimensions {width,height}
let globalAspectRatio = '1:1'; // Global aspect ratio setting
let globalResolution = 'big'; // Global resolution setting (default 1080p)
let userReplicateToken = null; // User-provided Replicate API token (memory only unless remembered)
let isSettingsOpen = false; // avoid repeated prompts/password manager popups
let hasPromptedForToken = false; // prompt only once per session automatically
let apiMode = 'proxy'; // Only proxy mode supported in production (avoid CORS)
let apiBase = '/api'; // Proxy base URL (configurable in Settings)

// Canvas helpers
const canvasStart = document.getElementById('canvasStart');
const canvasEnd = document.getElementById('canvasEnd');
const ctxStart = canvasStart.getContext('2d');
const ctxEnd = canvasEnd.getContext('2d');

async function drawImageOnCanvas(canvas, ctx, src, showFinalShimmer = false) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      // Clear canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      // Calculate how to crop/fit the image to current canvas size
      const canvasAspectRatio = canvas.width / canvas.height;
      const imgAspectRatio = img.width / img.height;
      let drawWidth, drawHeight, offsetX, offsetY;
      
      if (imgAspectRatio > canvasAspectRatio) {
        // Image is wider, crop sides
        drawHeight = canvas.height;
        drawWidth = drawHeight * imgAspectRatio;
        offsetX = (canvas.width - drawWidth) / 2;
        offsetY = 0;
      } else {
        // Image is taller, crop top/bottom
        drawWidth = canvas.width;
        drawHeight = drawWidth / imgAspectRatio;
        offsetX = 0;
        offsetY = (canvas.height - drawHeight) / 2;
      }
      
      ctx.drawImage(img, offsetX, offsetY, drawWidth, drawHeight);
      
      // Add final shimmer effect if requested
      if (showFinalShimmer) {
        showFinalShimmerEffect(canvas);
      }
      
      resolve();
    };
    img.onerror = reject;
    img.src = src;
  });
}

function showFinalShimmerEffect(canvas) {
  const canvasFrame = canvas.parentElement;
  const targetCanvas = canvas;

  // Ensure canvas frame is positioned relatively
  canvasFrame.style.position = 'relative';

  // Create final shimmer overlay exactly over the canvas area
  const finalShimmerOverlay = document.createElement('div');
  finalShimmerOverlay.className = 'final-shimmer-overlay';
  finalShimmerOverlay.style.position = 'absolute';
  finalShimmerOverlay.style.left = targetCanvas.offsetLeft + 'px';
  finalShimmerOverlay.style.top = targetCanvas.offsetTop + 'px';
  finalShimmerOverlay.style.width = targetCanvas.offsetWidth + 'px';
  finalShimmerOverlay.style.height = targetCanvas.offsetHeight + 'px';
  finalShimmerOverlay.style.borderRadius = getComputedStyle(targetCanvas).borderRadius || '16px';
  canvasFrame.appendChild(finalShimmerOverlay);

  // Remove overlay after animation completes
  setTimeout(() => {
    if (finalShimmerOverlay.parentNode) {
      finalShimmerOverlay.parentNode.removeChild(finalShimmerOverlay);
    }
  }, 1200);
}

function canvasToBlobURL(canvas, type = 'image/png', quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      resolve(URL.createObjectURL(blob));
    }, type, quality);
  });
}

// UI State Management Functions
function updateUIState() {
  const canvasArea = document.getElementById('canvasArea');
  const startFrame = document.getElementById('startFrame');
  const endFrame = document.getElementById('endFrame');
  const placeholder = document.getElementById('canvasPlaceholder');
  const modeToggle = document.getElementById('modeToggle');
  const historyElement = document.getElementById('imageHistory');
  const videoPreview = document.getElementById('videoPreview');
  const startDeleteBtn = document.querySelector('#startFrame .btn-delete');
  const endDeleteBtn = document.querySelector('#endFrame .btn-delete');
  
  // Toggle global class for video emphasis
  document.body.classList.toggle('video-mode', currentMode === 'video');
  
  const hasStartImage = canvasDisplayImages.start !== null;
  const hasEndImage = canvasDisplayImages.end !== null;
  const hasAnyImage = hasStartImage || hasEndImage;
  
  // Determine app state
  if (!hasStartImage && !hasEndImage) {
    appState = 'initial';
    // If both canvases are empty, force image mode to avoid being stuck in video mode
    if (currentMode === 'video') {
      currentMode = 'image';
      // Sync UI bits: mode buttons, prompt placeholder, duration pill
      const promptInput = document.getElementById('promptInput');
      if (promptInput) {
        promptInput.placeholder = promptMode === 'edit' ? 'make it look to its left side' : 'A cat in a hat...';
      }
      const modeBtns = document.querySelectorAll('.mode-btn');
      modeBtns.forEach(b => b.classList.remove('active'));
      const imageBtn = document.querySelector('.mode-btn[data-mode="image"]');
      if (imageBtn) imageBtn.classList.add('active');
      const durationPill = document.getElementById('durationPill');
      if (durationPill) durationPill.style.display = 'none';
    }
  } else if ((hasStartImage && !hasEndImage) || (!hasStartImage && hasEndImage)) {
    appState = 'single';
  } else if (hasStartImage && hasEndImage) {
    appState = 'dual';
  }
  
  // Update UI based on state
  switch(appState) {
    case 'initial':
      // Agora canvases sempre visíveis em estado vazio
      canvasArea.style.display = 'flex';
      startFrame.style.display = 'block';
      endFrame.style.display = 'block';
      modeToggle.style.display = 'none';
      videoPreview.style.display = currentMode === 'video' ? 'block' : 'none';
      break;
      
    case 'single':
      // Mostrar ambos canvas; o vazio fica clicável e com fundo
      canvasArea.style.display = 'flex';
      startFrame.style.display = 'block';
      endFrame.style.display = 'block';
      if (placeholder) placeholder.style.display = 'none';
      modeToggle.style.display = 'none';
      // Em modo vídeo, mostramos o player mesmo sem vídeo (com ratio global)
      videoPreview.style.display = currentMode === 'video' ? 'block' : 'none';
      break;
      
    case 'dual':
      // Estado 2 - dois canvas + modo vídeo disponível
      canvasArea.style.display = 'flex';
      startFrame.style.display = 'block';
      endFrame.style.display = 'block';
      if (placeholder) placeholder.style.display = 'none';
      modeToggle.style.display = 'flex';
      // Mostrar player em modo vídeo (mesmo sem vídeo)
      videoPreview.style.display = currentMode === 'video' ? 'block' : 'none';
      break;
  }
  
  // Update active canvas visual feedback
  updateActiveCanvas();
  
  // Show/hide frame controls based on state
  if (appState === 'dual') {
    if (hasStartImage) startFrame.classList.add('dual-mode');
    else startFrame.classList.remove('dual-mode');
    
    if (hasEndImage) endFrame.classList.add('dual-mode');
    else endFrame.classList.remove('dual-mode');
  } else {
    startFrame.classList.remove('dual-mode');
    endFrame.classList.remove('dual-mode');
  }
  
  // Hide/show edit/generate toggle based on mode
  const promptModeToggle = document.querySelector('.prompt-mode-toggle');
  if (promptModeToggle) {
    promptModeToggle.style.display = currentMode === 'video' ? 'none' : 'flex';
  }
  
  // Settings pills are always visible as global settings
  const settingsPills = document.querySelector('.settings-pills');
  if (settingsPills) {
    settingsPills.style.display = 'flex';
  }
  // Toggle resolution select only in video mode
  const resolutionSelectEl = document.getElementById('resolutionSelect');
  if (resolutionSelectEl) {
    resolutionSelectEl.style.display = currentMode === 'video' ? '' : 'none';
  }
  // Show upscale button only if there is an image loaded
  const upscaleBtn = document.getElementById('upscaleBtn');
  if (upscaleBtn) {
    upscaleBtn.style.display = hasAnyImage ? '' : 'none';
  }
  
  // History gallery exists as a slide-out; keep it in DOM always
  updateHistoryDisplay();

  // Toggle delete action visibility only when a canvas has an image
  if (startDeleteBtn) startDeleteBtn.style.display = canvasDisplayImages.start ? 'flex' : 'none';
  if (endDeleteBtn) endDeleteBtn.style.display = canvasDisplayImages.end ? 'flex' : 'none';

  // Recalcula layout responsivo para alinhar baselines e evitar rolagem
  computeAndApplyResponsiveLayout();
}

function updateVideoDimensions() { computeAndApplyResponsiveLayout(); }

function updateActiveCanvas() {
  const startFrame = document.getElementById('startFrame');
  const endFrame = document.getElementById('endFrame');
  
  // Remove active class from both
  startFrame.classList.remove('active');
  endFrame.classList.remove('active');
  
  // Add active class to current
  if (activeCanvas === 'start') {
    startFrame.classList.add('active');
  } else {
    endFrame.classList.add('active');
  }
  
  // Update indicator dots
  updateIndicatorDots();
}

function updateIndicatorDots() {
  const startDots = document.querySelectorAll('#startFrame .indicator-dot');
  const endDots = document.querySelectorAll('#endFrame .indicator-dot');
  
  // Reset all dots
  startDots.forEach(dot => dot.classList.remove('active'));
  endDots.forEach(dot => dot.classList.remove('active'));
  
  // Set active dots based on which frame has content
  if (canvasDisplayImages.start && startDots.length >= 2) {
    startDots[0].classList.add('active'); // Left dot active for start frame
  }
  if (canvasDisplayImages.end && endDots.length >= 2) {
    endDots[1].classList.add('active'); // Right dot active for end frame
  }
}

function updateHistoryDisplay() {
  const historyGrid = document.getElementById('historyGrid');
  historyGrid.innerHTML = '';
  
  imageHistory.forEach((entry, index) => {
    // Handle both old string format and new object format
    const displayUrl = typeof entry === 'string' ? entry : entry.displayUrl;
    const replicateUrl = typeof entry === 'string' ? entry : entry.replicateUrl;
    
    const historyItem = document.createElement('div');
    historyItem.className = 'history-item';
    historyItem.style.backgroundImage = `url(${displayUrl})`;
    historyItem.title = `Image ${index + 1}`;
    historyItem.draggable = true;
    
    // Click to select
    historyItem.addEventListener('click', () => selectFromHistory(displayUrl));
    
    // Drag functionality - pass the replicate URL for AI use
    historyItem.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', replicateUrl);
      e.dataTransfer.setData('image/url', replicateUrl);
      e.dataTransfer.setData('display/url', displayUrl);
      historyItem.classList.add('dragging');
    });
    
    historyItem.addEventListener('dragend', () => {
      historyItem.classList.remove('dragging');
    });
    
    historyGrid.appendChild(historyItem);
  });
}

function addToHistory(imageUrl, replicateUrl = null) {
  // Create history entry with both URLs if available
  const historyEntry = {
    displayUrl: imageUrl,
    replicateUrl: replicateUrl || imageUrl
  };
  
  // Check if already exists (by display URL)
  const exists = imageHistory.some(entry => 
    (typeof entry === 'string' && entry === imageUrl) ||
    (typeof entry === 'object' && entry.displayUrl === imageUrl)
  );
  
  if (!exists) {
    imageHistory.push(historyEntry);
    
    // Update history display first
    updateHistoryDisplay();
    
    // Add shimmer effect to the new thumbnail immediately
    const historyGrid = document.getElementById('historyGrid');
    const lastThumbnail = historyGrid.lastElementChild;
    if (lastThumbnail) {
      lastThumbnail.classList.add('loading-shimmer');
      
      // Create shimmer overlay for thumbnail
      const shimmerOverlay = document.createElement('div');
      shimmerOverlay.className = 'shimmer-overlay';
      shimmerOverlay.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: linear-gradient(90deg, transparent, rgba(255,255,255,0.5), rgba(255,255,255,0.7), rgba(255,255,255,0.5), transparent);
        animation: shimmer 1.8s ease-in-out infinite;
        pointer-events: none;
        z-index: 2;
        border-radius: 8px;
      `;
      
      lastThumbnail.style.position = 'relative';
      lastThumbnail.appendChild(shimmerOverlay);
      
      setTimeout(() => {
        lastThumbnail.classList.remove('loading-shimmer');
        if (shimmerOverlay.parentNode) {
          shimmerOverlay.parentNode.removeChild(shimmerOverlay);
        }
      }, 1500);
    }
    
    // Update UI state after history is updated
    updateUIState();
  }
}

async function selectFromHistory(imageUrl) {
  const canvasFrame = activeCanvas === 'start' ? 
    document.getElementById('startFrame') : 
    document.getElementById('endFrame');
  
  // Show loading state
  showCanvasLoading(canvasFrame);
  
  try {
    // Add selected image to active canvas with final shimmer
    if (activeCanvas === 'start') {
      await drawImageOnCanvas(canvasStart, ctxStart, imageUrl, true);
      canvasImages.start = imageUrl;
      canvasDisplayImages.start = imageUrl;
    } else {
      await drawImageOnCanvas(canvasEnd, ctxEnd, imageUrl, true);
      canvasImages.end = imageUrl;
      canvasDisplayImages.end = imageUrl;
    }
    updateUIState();
  } finally {
    // Hide loading state
    hideCanvasLoading(canvasFrame);
  }
}

// Add image directly to canvas (not as attachment)
async function addImageToCanvas(file, targetCanvas) {
  const canvasFrame = targetCanvas === 'start' ? 
    document.getElementById('startFrame') : 
    document.getElementById('endFrame');
  const canvas = canvasFrame.querySelector('canvas');
  
  try {
    // Force canvas to be visible immediately for loading feedback
    const canvasArea = document.querySelector('.canvas-area');
    const canvasContainer = document.querySelector('.canvas-container');
    const placeholder = document.getElementById('canvasPlaceholder');
    
    // Show canvas area and container
    canvasArea.style.display = 'flex';
    canvasContainer.style.display = 'flex';
    canvasFrame.style.display = 'flex';
    
    // Hide placeholder if it exists
    if (placeholder) {
      placeholder.style.display = 'none';
    }
    
    // Drag placeholder já foi tratado; aqui é o loading real
    // Agora que o canvas está visível e dimensionado, mostramos o shimmer de loading
    showCanvasLoading(canvasFrame);
    
    const url = URL.createObjectURL(file);
    
    // Upload file to Replicate for use with AI models
    console.log('Uploading file to canvas...');
    const replicateUrl = await replicateUpload(file);
    console.log('File uploaded successfully:', replicateUrl);
    
    // Draw image immediately with final shimmer effect (display only)
    if (targetCanvas === 'start') {
      await drawImageOnCanvas(canvasStart, ctxStart, url, false);
      canvasImages.start = replicateUrl; // Replicate URL or original for AI
      canvasDisplayImages.start = url; // Blob URL for display
    } else {
      await drawImageOnCanvas(canvasEnd, ctxEnd, url, false);
      canvasImages.end = replicateUrl; // Replicate URL or original for AI
      canvasDisplayImages.end = url; // Blob URL for display
    }
    
    // Add to history after successful canvas update
    addToHistory(url, replicateUrl);
    // Fade-in and final shimmer after image drawn
    const target = targetCanvas === 'start' ? canvasStart : canvasEnd;
    target.classList.add('canvas-fade-in');
    showFinalShimmerEffect(target);
    updateUIState();
    
  } catch (error) {
    console.error('Error adding image to canvas:', error);
    alert('Erro ao fazer upload da imagem: ' + error.message);
    // Restore UI state on error
    updateUIState();
  } finally {
    hideCanvasLoading(canvasFrame);
  }
}

// Add image as attachment (for prompts)
async function addImageAsAttachment(file) {
  const addBtn = document.getElementById('addBtn');
  
  try {
    // Show loading state
    showButtonLoading(addBtn, 'Enviando...');
    
    console.log('Adding image as attachment...');
    const replicateUrl = await replicateUpload(file);
    uploadedFiles.push(replicateUrl);
    updateFileDisplay(file);
    console.log('Attachment added:', replicateUrl);
  } catch (error) {
    console.error('Error adding attachment:', error);
    alert('Erro ao adicionar anexo: ' + error.message);
  } finally {
    // Hide loading state
    hideButtonLoading(addBtn);
  }
}

// Event Listeners for New UI
document.addEventListener('DOMContentLoaded', () => {
  
  // Mode toggle
  const modeBtns = document.querySelectorAll('.mode-btn');
  modeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      modeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentMode = btn.dataset.mode;
      
      // Update placeholder and mode based on current mode
      const promptInput = document.getElementById('promptInput');
      const durationPill = document.getElementById('durationPill');
      if (currentMode === 'video') {
        // Reset to generate mode for video
        const promptModeBtns = document.querySelectorAll('.prompt-mode-btn');
        promptModeBtns.forEach(b => b.classList.remove('active'));
        document.querySelector('.prompt-mode-btn[data-mode="generate"]').classList.add('active');
        promptMode = 'generate';
        promptInput.placeholder = 'Cat running in the park...';
        if (durationPill) durationPill.style.display = 'flex';
        const promptModeToggleEl = document.querySelector('.prompt-mode-toggle');
        if (promptModeToggleEl) promptModeToggleEl.classList.remove('is-edit');
      } else {
        // Back to image mode - restore appropriate placeholder
        if (promptMode === 'edit') {
          promptInput.placeholder = 'make it look to its left side';
        } else {
          promptInput.placeholder = 'A cat in a hat...';
        }
        if (durationPill) durationPill.style.display = 'none';
      }
      
      updateUIState();

      // Old video controls removed; duration now lives in pill group
    });
  });
  
  // Prompt mode toggle (Generate/Edit)
  const promptModeBtns = document.querySelectorAll('.prompt-mode-btn');
  const promptModeToggleEl = document.querySelector('.prompt-mode-toggle');

  // Helper to size/move indicator to match the active button
  function updatePromptModeIndicator() {
    if (!promptModeToggleEl) return;
    const activeBtn = document.querySelector('.prompt-mode-btn.active');
    if (!activeBtn) return;
    const toggleRect = promptModeToggleEl.getBoundingClientRect();
    const btnRect = activeBtn.getBoundingClientRect();
    const x = Math.max(0, btnRect.left - toggleRect.left);
    const w = Math.max(20, btnRect.width);
    promptModeToggleEl.style.setProperty('--pm-indicator-x', x + 'px');
    promptModeToggleEl.style.setProperty('--pm-indicator-w', Math.min(w, toggleRect.width - 4) + 'px');
  }

  promptModeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      promptModeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      promptMode = btn.dataset.mode;
      
      // Update placeholder based on mode
      const promptInput = document.getElementById('promptInput');
      if (promptMode === 'edit') {
        promptInput.placeholder = 'make it look to its left side';
      } else {
        promptInput.placeholder = 'A cat in a hat...';
      }
      updatePromptModeIndicator();
    });
  });

  // Initialize indicator on load and on resize (keeps width matching text)
  updatePromptModeIndicator();
  window.addEventListener('resize', updatePromptModeIndicator);
  
  // Canvas selection
  document.getElementById('startFrame').addEventListener('click', () => {
    activeCanvas = 'start';
    updateActiveCanvas();
  });
  
  document.getElementById('endFrame').addEventListener('click', () => {
    activeCanvas = 'end';
    updateActiveCanvas();
  });

  // Image actions (download/delete) with event delegation
  document.querySelectorAll('.canvas-frame').forEach(frame => {
    frame.addEventListener('click', async (e) => {
      if (e.target.closest('.btn-download')) {
        e.stopPropagation();
        const isStart = frame.id === 'startFrame';
        // Prefer the original display URL (blob or remote). Fallback to canvasImages.
        const srcUrl = isStart ? (canvasDisplayImages.start || canvasImages.start) : (canvasDisplayImages.end || canvasImages.end);
        if (!srcUrl) return;

        try {
          let downloadUrl = srcUrl;
          // If not a blob URL, fetch and convert to blob to preserve filename/control
          if (!srcUrl.startsWith('blob:')) {
            const res = await fetch(srcUrl, { mode: 'cors' });
            const blob = await res.blob();
            downloadUrl = URL.createObjectURL(blob);
          }
          const a = document.createElement('a');
          a.href = downloadUrl;
          const defaultName = isStart ? 'start-original' : 'end-original';
          const extMatch = (srcUrl.split('?')[0] || '').match(/\.([a-zA-Z0-9]+)$/);
          const ext = extMatch ? extMatch[1] : 'png';
          a.download = `${defaultName}.${ext}`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          if (downloadUrl.startsWith('blob:') && downloadUrl !== srcUrl) {
            URL.revokeObjectURL(downloadUrl);
          }
        } catch (_) {
          // Silent fail; optionally show a toast later
        }
      } else if (e.target.closest('.btn-delete')) {
        e.stopPropagation();
        const isStart = frame.id === 'startFrame';
        const canvas = isStart ? canvasStart : canvasEnd;
        const ctx = isStart ? ctxStart : ctxEnd;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (isStart) { canvasImages.start = null; canvasDisplayImages.start = null; }
        else { canvasImages.end = null; canvasDisplayImages.end = null; }
        updateUIState();
      }
    });
  });
  
  // Canvas placeholder click
  const canvasPlaceholder = document.getElementById('canvasPlaceholder');
  if (canvasPlaceholder) {
    canvasPlaceholder.addEventListener('click', () => {
      activeCanvas = 'end';
      updateActiveCanvas();
      // Show end frame area for interaction
      if (appState === 'single') {
        // Trigger placeholder to add end frame
        document.getElementById('endFileInput').click();
      }
    });
  }
  
  // Frame indicator toggles - click anywhere in indicator toggles start/end
  document.addEventListener('click', (e) => {
    if (e.target.closest('.frame-indicator')) {
      e.stopPropagation();
      const frameElement = e.target.closest('.canvas-frame');
      // Toggle dependendo do frame e lado
      const isStartFrame = frameElement.id === 'startFrame';
      const isEndFrame = frameElement.id === 'endFrame';
      // Se clicar no indicador do start, mover start->end; no do end, end->start (se houver imagem)
      const isLeftDot = e.target.classList.contains('indicator-dot') && e.target === e.target.parentElement.querySelector('.indicator-dot:first-child');
      
      if (frameElement.id === 'startFrame') {
        if (!isLeftDot && canvasDisplayImages.start) { // Right dot clicked on start frame = move to end
          const startDisplayImage = canvasDisplayImages.start;
          const startReplicateImage = canvasImages.start;
          const endDisplayImage = canvasDisplayImages.end;
          const endReplicateImage = canvasImages.end;
          
          // Show loading on both frames during swap
          const startFrame = document.getElementById('startFrame');
          const endFrame = document.getElementById('endFrame');
          
          if (endDisplayImage) {
            // Swap mode - show loading on both
            showCanvasLoading(startFrame);
            showCanvasLoading(endFrame);
          } else {
            // Move mode - show loading on target only
            showCanvasLoading(endFrame);
          }
          
          try {
            // Animate the change
            animateCanvasChange(canvasEnd, async () => {
              await drawImageOnCanvas(canvasEnd, ctxEnd, startDisplayImage, false);
              canvasImages.end = startReplicateImage;
              canvasDisplayImages.end = startDisplayImage;
              
              if (endDisplayImage) {
                // Swap: move end image to start
                animateCanvasChange(canvasStart, async () => {
                  await drawImageOnCanvas(canvasStart, ctxStart, endDisplayImage, false);
                  canvasImages.start = endReplicateImage;
                  canvasDisplayImages.start = endDisplayImage;
                  activeCanvas = 'start';
                  updateUIState();
                });
              } else {
                // Just move start to end
                ctxStart.clearRect(0, 0, canvasStart.width, canvasStart.height);
                canvasImages.start = null;
                canvasDisplayImages.start = null;
                activeCanvas = 'end';
                updateUIState();
              }
            });
          } finally {
            // Hide loading states
            hideCanvasLoading(startFrame);
            hideCanvasLoading(endFrame);
          }
        }
      } else if (frameElement.id === 'endFrame') {
        if (isLeftDot && canvasDisplayImages.end) { // Left dot clicked on end frame = move to start
          const endDisplayImage = canvasDisplayImages.end;
          const endReplicateImage = canvasImages.end;
          const startDisplayImage = canvasDisplayImages.start;
          const startReplicateImage = canvasImages.start;
          
          // Show loading on frames during swap
          const startFrame = document.getElementById('startFrame');
          const endFrame = document.getElementById('endFrame');
          
          if (startDisplayImage) {
            // Swap mode - show loading on both
            showCanvasLoading(startFrame);
            showCanvasLoading(endFrame);
          } else {
            // Move mode - show loading on target only
            showCanvasLoading(startFrame);
          }
          
          try {
            // Animate the change
            animateCanvasChange(canvasStart, async () => {
              await drawImageOnCanvas(canvasStart, ctxStart, endDisplayImage, false);
              canvasImages.start = endReplicateImage;
              canvasDisplayImages.start = endDisplayImage;
              
              if (startDisplayImage) {
                // Swap: move start image to end
                animateCanvasChange(canvasEnd, async () => {
                  await drawImageOnCanvas(canvasEnd, ctxEnd, startDisplayImage, false);
                  canvasImages.end = startReplicateImage;
                  canvasDisplayImages.end = startDisplayImage;
                  activeCanvas = 'end';
                  updateUIState();
                });
              } else {
                // Just move end to start
                ctxEnd.clearRect(0, 0, canvasEnd.width, canvasEnd.height);
                canvasImages.end = null;
                canvasDisplayImages.end = null;
                activeCanvas = 'start';
                updateUIState();
              }
            });
          } finally {
            // Hide loading states
            hideCanvasLoading(startFrame);
            hideCanvasLoading(endFrame);
          }
        }
      }
      updateUIState();
    }
  });
  
  // Canvas upload buttons
  document.getElementById('startUpload').addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('startFileInput').click();
  });
  
  document.getElementById('endUpload').addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('endFileInput').click();
  });
  
  // Canvas file inputs
  document.getElementById('startFileInput').addEventListener('change', async (e) => {
    if (e.target.files[0]) {
      await addImageToCanvas(e.target.files[0], 'start');
      e.target.value = '';
    }
  });
  
  document.getElementById('endFileInput').addEventListener('change', async (e) => {
    if (e.target.files[0]) {
      await addImageToCanvas(e.target.files[0], 'end');
      e.target.value = '';
    }
  });
  
  // Attachment file input (+ button in prompt bar)
  const fileInput = document.getElementById('fileInput');
  const addBtn = document.getElementById('addBtn');
  
  addBtn.addEventListener('click', () => {
    fileInput.click();
  });
  
  fileInput.addEventListener('change', async (e) => {
    for (const file of e.target.files) {
      if (file.type.startsWith('image/')) {
        await addImageAsAttachment(file);
      }
    }
    fileInput.value = ''; // Reset input
  });
  
  // Autosize prompt textarea up to 4 lines
  const promptTextarea = document.getElementById('promptInput');
  const autosize = () => {
    if (!promptTextarea) return;
    promptTextarea.style.height = 'auto';
    const styles = getComputedStyle(promptTextarea);
    const lh = parseFloat(styles.lineHeight) || (parseFloat(styles.fontSize) * 1.35);
    const maxH = Math.ceil(lh * 5 + 4);
    const minH = Math.ceil(lh + 2);
    const needed = Math.min(Math.max(promptTextarea.scrollHeight, minH), maxH);
    promptTextarea.style.height = needed + 'px';
    const promptBar = document.querySelector('.prompt-bar');
    if (promptBar) {
      if (needed > minH + 2) promptBar.classList.add('expanded');
      else promptBar.classList.remove('expanded');
    }
  };
  if (promptTextarea) {
    promptTextarea.addEventListener('input', autosize);
    setTimeout(autosize, 0);
  }

  // Play button
  const playBtn = document.getElementById('playBtn');
  playBtn.addEventListener('click', async () => {
    const prompt = document.getElementById('promptInput').value.trim();
    if (!prompt) {
      alert('Digite um prompt primeiro!');
      return;
    }
    
    if (currentMode === 'image') {
      if (promptMode === 'edit') {
        // Edit mode: Edit existing image in active canvas
        const activeImage = activeCanvas === 'start' ? canvasImages.start : canvasImages.end;
        if (activeImage) {
          const editedUrl = await editImage(prompt);
          if (editedUrl) {
            // Add to history first (generated images use same URL for display and AI)
            addToHistory(editedUrl);
            
            if (activeCanvas === 'start') {
              await drawImageOnCanvas(canvasStart, ctxStart, editedUrl, false);
              canvasImages.start = editedUrl;
              canvasDisplayImages.start = editedUrl;
            } else {
              await drawImageOnCanvas(canvasEnd, ctxEnd, editedUrl, false);
              canvasImages.end = editedUrl;
              canvasDisplayImages.end = editedUrl;
            }
            const target = activeCanvas === 'start' ? canvasStart : canvasEnd;
            target.classList.add('canvas-fade-in');
            showFinalShimmerEffect(target);
            updateUIState();
          }
        } else {
          alert('Selecione uma imagem para editar primeiro!');
        }
      } else {
        // Generate mode: Generate new image for active canvas
        await generateImageForActiveCanvas(prompt);
      }
    } else {
      // Video mode: Generate video if we have both start and end frames
      await generateVideo(prompt);
    }
  });
  
  // Aspect ratio and resolution dropdowns
  const aspectRatioSelect = document.getElementById('aspectRatioSelect');
  const resolutionSelect = document.getElementById('resolutionSelect');
  const orientationToggle = document.getElementById('orientationToggle');
  const historyToggle = document.getElementById('historyToggle');
  const closeHistoryBtn = document.getElementById('closeHistoryBtn');
  const settingsToggle = document.getElementById('settingsToggle');
  const settingsOverlay = document.getElementById('settingsOverlay');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');
  const saveSettingsBtn = document.getElementById('saveSettingsBtn');
  const cancelSettingsBtn = document.getElementById('cancelSettingsBtn');
  const apiKeyInput = document.getElementById('replicateApiKey');
  const rememberCheckbox = document.getElementById('rememberApiKey');
  const apiProxyUrlInput = document.getElementById('apiProxyUrl');
  
  aspectRatioSelect.addEventListener('change', (e) => {
    globalAspectRatio = getOrientedAspectRatio(e.target.value);
    updateCanvasDimensions();
  });
  
  orientationToggle.addEventListener('click', () => {
    const isVertical = orientationToggle.classList.toggle('vertical');
    const baseRatio = aspectRatioSelect.value;
    globalAspectRatio = getOrientedAspectRatio(baseRatio);
    updateCanvasDimensions();
  });
  
  resolutionSelect.addEventListener('change', (e) => {
    globalResolution = e.target.value;
  });
  
  // History toggle (slide-in/out)
  if (historyToggle) {
    historyToggle.addEventListener('click', () => {
      const gallery = document.getElementById('imageHistory');
      if (!gallery) return;
      gallery.classList.toggle('open');
    });
  }
  if (closeHistoryBtn) {
    closeHistoryBtn.addEventListener('click', () => {
      const gallery = document.getElementById('imageHistory');
      if (gallery) gallery.classList.remove('open');
    });
  }
  
  // Minimal settings modal handlers
  window.openSettings = function openSettings() {
    if (!settingsOverlay) return;
    if (isSettingsOpen) return;
    // Prefill from memory/localStorage without exposing in DOM when not needed
    const saved = localStorage.getItem('replicate_api_key');
    const savedProxy = localStorage.getItem('replicate_api_proxy_base');
    if (saved) {
      apiKeyInput.value = '••••••••••••••'; // masked placeholder
      rememberCheckbox.checked = true;
    } else {
      apiKeyInput.value = '';
      rememberCheckbox.checked = false;
    }
    if (apiProxyUrlInput) apiProxyUrlInput.value = savedProxy || '';
    settingsOverlay.style.display = 'flex';
    isSettingsOpen = true;
  }
  window.closeSettings = function closeSettings() {
    if (!settingsOverlay) return;
    settingsOverlay.style.display = 'none';
    isSettingsOpen = false;
  }
  if (settingsToggle) settingsToggle.addEventListener('click', openSettings);
  if (closeSettingsBtn) closeSettingsBtn.addEventListener('click', closeSettings);
  if (cancelSettingsBtn) cancelSettingsBtn.addEventListener('click', closeSettings);
  if (settingsOverlay) settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeSettings(); });
  
  if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener('click', () => {
      const saved = localStorage.getItem('replicate_api_key');
      const inputVal = apiKeyInput.value.trim();
      const proxyValRaw = (apiProxyUrlInput?.value || '').trim();
      const proxyVal = proxyValRaw ? proxyValRaw.replace(/\/$/, '') : '';
      let effective = null;
      // If input shows mask and we had saved token, keep it
      if (inputVal === '••••••••••••••' && saved) {
        effective = saved;
      } else if (inputVal) {
        effective = inputVal;
      }
      userReplicateToken = effective;
      if (proxyVal) {
        localStorage.setItem('replicate_api_proxy_base', proxyVal);
        apiBase = proxyVal.endsWith('/api') ? proxyVal : `${proxyVal}/api`;
        apiMode = 'proxy';
      } else {
        localStorage.removeItem('replicate_api_proxy_base');
        apiBase = '/api';
        apiMode = 'proxy';
      }
      if (rememberCheckbox.checked && effective) {
        try {
          localStorage.setItem('replicate_api_key', effective);
        } catch (_) {}
      } else {
        localStorage.removeItem('replicate_api_key');
      }
      // Validate token with a lightweight call to avoid repeated password manager prompts
      if (effective) {
        const checkUrl = `${apiBase}/check-token`;
        const check = fetch(checkUrl, { headers: { 'X-Replicate-Token': effective } });
        check
          .then(async (r) => {
            if (!r.ok) throw new Error(await r.text());
            closeSettings();
          })
          .catch((err) => {
            alert('Invalid Replicate API key: ' + (err?.message || ''));
          });
      } else {
        closeSettings();
      }
    });
  }
  
  // On load, hydrate from localStorage but never print it into DOM
  (function hydrateApiKeyFromStorage() {
    const saved = localStorage.getItem('replicate_api_key');
    if (saved) {
      userReplicateToken = saved;
    }
  })();

  // If no token found, prompt once at startup to avoid prompting every action
  setTimeout(() => {
    if (!userReplicateToken && !hasPromptedForToken) {
      hasPromptedForToken = true;
      openSettings();
    }
  }, 200);
  
  // Decide API mode: default to proxy to avoid CORS; allow custom proxy via Settings
  const savedProxy = localStorage.getItem('replicate_api_proxy_base');
  if (savedProxy) {
    apiBase = savedProxy.endsWith('/api') ? savedProxy : `${savedProxy}/api`;
    apiMode = 'proxy';
  }
  
  // Upscale button
  const upscaleBtn = document.getElementById('upscaleBtn');
  if (upscaleBtn) {
    upscaleBtn.addEventListener('click', async () => {
      if (currentMode === 'video') {
        await upscaleVideoFramesStub();
        return;
      }
      await upscaleActiveCanvas();
    });
  }
  
  // Initialize aspect ratio and canvas dimensions
  globalAspectRatio = getOrientedAspectRatio(aspectRatioSelect.value);
  updateCanvasDimensions();
  
  // Initialize UI state
  updateUIState();
  
  // Initialize drag & drop
  initializeDragAndDrop();
  
  // Initialize canvas drop zones for history images
  initializeCanvasDropZones();
  initializeInterCanvasDragAndDrop();

  // Ensure video preview matches canvas ratio initially
  computeAndApplyResponsiveLayout();

  // Recompute on resize to avoid scrolling and keep baseline alignment
  window.addEventListener('resize', () => {
    computeAndApplyResponsiveLayout();
  });

  // Initial duration pill visibility based on mode
  const durationPill = document.getElementById('durationPill');
  if (durationPill) durationPill.style.display = currentMode === 'video' ? 'flex' : 'none';
});

// Upscale current active canvas image using bria/increase-resolution
async function upscaleActiveCanvas() {
  const upscaleBtn = document.getElementById('upscaleBtn');
  const canvasFrame = activeCanvas === 'start' ? 
    document.getElementById('startFrame') : 
    document.getElementById('endFrame');
  
  try {
    const sourceImageUrl = activeCanvas === 'start' ? canvasImages.start : canvasImages.end;
    if (!sourceImageUrl) {
      alert('Selecione uma imagem para fazer upscale primeiro!');
      return;
    }
    
    showButtonLoading(upscaleBtn, 'Upscaling...');
    showCanvasLoading(canvasFrame);
    
    const input = {
      image_url: sourceImageUrl,
      desired_increase: 4,
      preserve_alpha: true,
      sync: true,
      content_moderation: false
    };
    
    console.log('Upscaling with bria/increase-resolution...', input);
    const outputs = await replicateRun('bria/increase-resolution', input);
    const imageUrl = Array.isArray(outputs) ? outputs[0] : outputs;
    
    if (activeCanvas === 'start') {
      await drawImageOnCanvas(canvasStart, ctxStart, imageUrl, false);
      canvasImages.start = imageUrl;
      canvasDisplayImages.start = imageUrl;
    } else {
      await drawImageOnCanvas(canvasEnd, ctxEnd, imageUrl, false);
      canvasImages.end = imageUrl;
      canvasDisplayImages.end = imageUrl;
    }
    
    addToHistory(imageUrl);
    const target = activeCanvas === 'start' ? canvasStart : canvasEnd;
    target.classList.add('canvas-fade-in');
    showFinalShimmerEffect(target);
    updateUIState();
  } catch (err) {
    console.error('Error during upscale:', err);
    alert('Erro ao fazer upscale: ' + err.message);
  } finally {
    hideButtonLoading(upscaleBtn);
    hideCanvasLoading(canvasFrame);
  }
}

// Prepare path for video upscale (stub for future model integration)
async function upscaleVideoFramesStub() {
  try {
    alert('Upscale de vídeo será adicionado em breve.');
  } catch (_) {
    // no-op
  }
}

// Loading state management
function showCanvasLoading(canvasFrame) {
  canvasFrame.classList.add('loading');

  // Shimmer overlay sized to canvas
  if (!canvasFrame.querySelector('.shimmer-overlay')) {
    const canvas = canvasFrame.querySelector('canvas');
    if (canvas) {
      // Ensure we remove any fade class while loading
      canvas.classList.remove('canvas-fade-in');
      const shimmerOverlay = document.createElement('div');
      shimmerOverlay.className = 'shimmer-overlay';
      shimmerOverlay.style.position = 'absolute';
      shimmerOverlay.style.left = canvas.offsetLeft + 'px';
      shimmerOverlay.style.top = canvas.offsetTop + 'px';
      shimmerOverlay.style.width = canvas.offsetWidth + 'px';
      shimmerOverlay.style.height = canvas.offsetHeight + 'px';
      shimmerOverlay.style.borderRadius = getComputedStyle(canvas).borderRadius || '16px';
      canvasFrame.appendChild(shimmerOverlay);
    }
  }
}

function hideCanvasLoading(canvasFrame) {
  canvasFrame.classList.remove('loading');
  
  // Remove shimmer overlays
  canvasFrame.querySelectorAll('.shimmer-overlay').forEach(el => el.remove());
}

function showButtonLoading(button, loadingText = '') {
  button.classList.add('button-loading');
  
  // Store original content
  if (!button.dataset.originalContent) {
    button.dataset.originalContent = button.innerHTML;
  }
  
  // Set loading content
  if (loadingText) {
    button.innerHTML = `<span class="button-text">${loadingText}</span>`;
  } else {
    button.innerHTML = `<span class="button-text">${button.dataset.originalContent}</span>`;
  }
  
  button.disabled = true;
}

function hideButtonLoading(button) {
  button.classList.remove('button-loading');
  
  if (button.dataset.originalContent) {
    button.innerHTML = button.dataset.originalContent;
  }
  
  button.disabled = false;
}

function showGlobalLoading(element, message = 'Carregando...') {
  element.classList.add('loading-shimmer');
  
  // Add subtle opacity
  element.style.opacity = '0.8';
  element.style.pointerEvents = 'none';
}

function hideGlobalLoading(element) {
  element.classList.remove('loading-shimmer');
  element.style.opacity = '';
  element.style.pointerEvents = '';
}

// Get aspect ratio based on orientation toggle
function getOrientedAspectRatio(baseRatio) {
  const orientationToggle = document.getElementById('orientationToggle');
  const isVertical = orientationToggle && orientationToggle.classList.contains('vertical');
  
  if (baseRatio === '1:1') return '1:1'; // Square stays square
  
  if (isVertical) {
    // Flip the ratio for vertical
    const [w, h] = baseRatio.split(':');
    return `${h}:${w}`;
  }
  
  return baseRatio; // Horizontal (default)
}

// Animate canvas changes with fade effect
function animateCanvasChange(canvas, callback) {
  const frame = canvas.parentElement;
  frame.style.opacity = '0.5';
  frame.style.transition = 'opacity 0.3s ease';
  
  setTimeout(() => {
    callback();
    frame.style.opacity = '1';
  }, 150);
}

// Update canvas dimensions and redraw with new aspect ratio
function updateCanvasDimensions() { computeAndApplyResponsiveLayout(); }

// Compute responsive sizes so that the bottoms align and everything fits viewport
function computeAndApplyResponsiveLayout() {
  const videoPreview = document.getElementById('videoPreview');
  const videoPlayer = document.getElementById('videoPlayer');
  const footerBar = document.querySelector('.footer-bar');
  const framesGroup = document.querySelector('.frames-group');
  if (!videoPreview || !videoPlayer || !framesGroup) return;

  const [ratioW, ratioH] = globalAspectRatio.split(':').map(Number);
  const aspect = ratioW / ratioH;
  const showVideo = currentMode === 'video';

  // Available height = viewport - footer - top paddings/gaps
  const footerH = footerBar ? footerBar.offsetHeight : 0;
  const verticalPaddingAndGaps = 80; // app padding + canvas area gap approx
  const availableH = Math.max(260, window.innerHeight - footerH - verticalPaddingAndGaps);

  // Start with target video height and cap by available height
  let videoH = Math.min(availableH, showVideo ? 720 : 560);
  let videoW = Math.round(videoH * aspect);
  if (showVideo) {
    if (aspect >= 1) {
      const maxVideoW = Math.floor(window.innerWidth * 0.52);
      if (videoW > maxVideoW) {
        videoW = maxVideoW;
        videoH = Math.round(videoW / aspect);
      }
    } else {
      const maxVideoH = Math.floor(availableH);
      if (videoH > maxVideoH) videoH = maxVideoH;
      videoW = Math.round(videoH * aspect);
    }
  } else {
    // When video is hidden, we don't need to allocate width for it
    videoW = 0;
  }

  // Canvas base size proportional to video height
  let canvasLarge = Math.round(videoH * 0.55);
  // 15% larger when there is no player (image mode)
  if (!showVideo) canvasLarge = Math.round(canvasLarge * 1.15);
  if (!showVideo) canvasLarge = Math.min(canvasLarge, 520);

  let canvasW, canvasH;
  if (aspect >= 1) {
    canvasW = canvasLarge;
    canvasH = Math.max(160, Math.round(canvasLarge / aspect));
  } else {
    canvasH = canvasLarge;
    canvasW = Math.max(160, Math.round(canvasLarge * aspect));
  }

  // Fit to viewport width considering two canvases + video + gaps
  const leftGap = 18; // frames-group gap
  const gridGap = 28; // canvas-container gap
  let totalW = (canvasW * 2) + leftGap + (showVideo ? (gridGap + videoW) : 0);
  const horizontalPadding = 40; // app-container side paddings
  const availableW = window.innerWidth - horizontalPadding;
  if (totalW > availableW) {
    const scale = availableW / totalW;
    videoW = Math.floor(videoW * scale);
    videoH = Math.floor(videoH * scale);
    canvasW = Math.floor(canvasW * scale);
    canvasH = Math.floor(canvasH * scale);
    totalW = availableW;
  }

  // Apply video sizes
  if (showVideo) {
    videoPreview.style.display = 'block';
    videoPlayer.style.width = videoW + 'px';
    videoPlayer.style.height = videoH + 'px';
    videoPreview.style.width = videoW + 'px';
    videoPreview.style.height = videoH + 'px';
  } else {
    videoPreview.style.display = 'none';
  }

  // Apply canvas sizes
  [canvasStart, canvasEnd].forEach(canvas => {
    canvas.width = canvasW;
    canvas.height = canvasH;
    canvas.style.width = canvasW + 'px';
    canvas.style.height = canvasH + 'px';
  });

  // Redraw images to fit new sizes
  const startImageData = canvasDisplayImages.start;
  const endImageData = canvasDisplayImages.end;
  if (startImageData) {
    drawImageOnCanvas(canvasStart, ctxStart, startImageData);
  }
  if (endImageData) {
    drawImageOnCanvas(canvasEnd, ctxEnd, endImageData);
  }

  // Remember last video size when a video is present
  if (currentVideo) {
    lastVideoSize = { width: videoW, height: videoH };
  }
}

// Initialize canvas drop zones for history images and external files
function initializeCanvasDropZones() {
  const startFrame = document.getElementById('startFrame');
  const endFrame = document.getElementById('endFrame');
  
  [startFrame, endFrame].forEach(frame => {
    const isStart = frame.id === 'startFrame';
    
    frame.addEventListener('dragover', (e) => {
      e.preventDefault();
      
      // Handle both history images and external files
      if (e.dataTransfer.types.includes('image/url') || e.dataTransfer.types.includes('Files')) {
        frame.classList.add('drop-target');
        // Do not add shimmer during dragover
      }
    });
    
    frame.addEventListener('dragleave', (e) => {
      if (!frame.contains(e.relatedTarget)) {
        frame.classList.remove('drop-target');
      }
    });
    
    frame.addEventListener('drop', async (e) => {
      e.preventDefault();
      frame.classList.remove('drop-target');
      
      // Handle history image drop only
      const replicateUrl = e.dataTransfer.getData('image/url');
      const displayUrl = e.dataTransfer.getData('display/url') || replicateUrl;
      
      if (replicateUrl) {
        // Show loading state (spinner + shimmer) only during loading
        showCanvasLoading(frame);
        
        try {
          if (isStart) {
            await drawImageOnCanvas(canvasStart, ctxStart, displayUrl, false);
            canvasImages.start = replicateUrl; // Store Replicate URL for AI
            canvasDisplayImages.start = displayUrl; // Store display URL
          } else {
            await drawImageOnCanvas(canvasEnd, ctxEnd, displayUrl, false);
            canvasImages.end = replicateUrl; // Store Replicate URL for AI
            canvasDisplayImages.end = displayUrl; // Store display URL
          }
          const target = isStart ? canvasStart : canvasEnd;
          target.classList.add('canvas-fade-in');
          showFinalShimmerEffect(target);
          updateUIState();
        } finally {
          hideCanvasLoading(frame);
        }
      }
      
      // External file drops are handled by the global drop handler
      // This avoids duplicate processing
    });
  });
}

// Enable drag-and-drop between canvases to duplicate image
function initializeInterCanvasDragAndDrop() {
  const startFrame = document.getElementById('startFrame');
  const endFrame = document.getElementById('endFrame');

  // Make canvases draggable sources
  [
    { frame: startFrame, canvas: canvasStart, slot: 'start' },
    { frame: endFrame, canvas: canvasEnd, slot: 'end' }
  ].forEach(({ frame, canvas, slot }) => {
    const canvasEl = canvas; // actual <canvas>
    canvasEl.setAttribute('draggable', 'true');
    canvasEl.addEventListener('dragstart', (e) => {
      const displayUrl = slot === 'start' ? canvasDisplayImages.start : canvasDisplayImages.end;
      const replicateUrl = slot === 'start' ? canvasImages.start : canvasImages.end;
      if (!displayUrl && !replicateUrl) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData('image/url', replicateUrl || displayUrl);
      e.dataTransfer.setData('display/url', displayUrl || replicateUrl);
      e.dataTransfer.effectAllowed = 'copy';
      frame.classList.add('dragging');
    });
    canvasEl.addEventListener('dragend', () => {
      frame.classList.remove('dragging');
    });
  });

  // Allow dropping onto frames (reusing existing drop handler already supports image/url)
  ;
}

// Drag & Drop functionality
function initializeDragAndDrop() {
  const appContainer = document.querySelector('.app-container');
  const dragOverlay = document.getElementById('dragOverlay');
  let dragCounter = 0;

  // Prevent default drag behaviors on the entire document
  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  document.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  // Handle drag enter on app container
  appContainer.addEventListener('dragenter', (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    dragCounter++;
    
    // Only show overlay if dragging files
    if (e.dataTransfer.types.includes('Files')) {
      showDragOverlay();
    }
  });

  // Handle drag over
  appContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (e.dataTransfer.types.includes('Files')) {
      e.dataTransfer.dropEffect = 'copy';
    }
  });

  // Handle drag leave
  appContainer.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    dragCounter--;
    
    if (dragCounter === 0) {
      hideDragOverlay();
    }
  });

  // Handle drop
  appContainer.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    dragCounter = 0;
    
    const files = Array.from(e.dataTransfer.files);
    const imageFiles = files.filter(file => file.type.startsWith('image/'));
    
    if (imageFiles.length > 0) {
      // Determine which canvas to use based on current state
      let targetCanvas = 'start';
      
      if (appState === 'single' && canvasDisplayImages.start && !canvasDisplayImages.end) {
        // If we have start but no end, use end
        targetCanvas = 'end';
      } else if (appState === 'dual') {
        // If both exist, use the active canvas
        targetCanvas = activeCanvas;
      }
      
      // Hide all placeholders
      hideCanvasPlaceholders();
      
      try {
        // addImageToCanvas will handle visibility and shimmer loading state
        await addImageToCanvas(imageFiles[0], targetCanvas);
        
        // Show success feedback
        showDropSuccess(targetCanvas);
      } catch (error) {
        console.error('Error processing dropped file:', error);
      }
    } else {
      // Hide overlay if no image files
      hideDragOverlay();
    }
  });
}

function showCanvasPlaceholders() {
  const canvasArea = document.querySelector('.canvas-area');
  const startFrame = document.getElementById('startFrame');
  const endFrame = document.getElementById('endFrame');
  const canvasContainer = document.querySelector('.canvas-container');
  const placeholder = document.getElementById('canvasPlaceholder');
  
  // Force canvas area to be visible
  canvasArea.style.display = 'flex';
  canvasContainer.style.display = 'flex';
  
  // Hide placeholder if it exists
  if (placeholder) {
    placeholder.style.display = 'none';
  }
  
  // Show both frames
  startFrame.style.display = 'flex';
  endFrame.style.display = 'flex';
  
  // Add drop placeholder class to both frames
  startFrame.classList.add('drop-placeholder');
  endFrame.classList.add('drop-placeholder');

  // Do NOT add shimmer during placeholders; only visual drop hint
}

function hideCanvasPlaceholders() {
  const startFrame = document.getElementById('startFrame');
  const endFrame = document.getElementById('endFrame');
  
  // Remove drop placeholder class
  startFrame.classList.remove('drop-placeholder');
  endFrame.classList.remove('drop-placeholder');
  
  // Restore original UI state
  updateUIState();
}

function showDragOverlay() {
  // Now using canvas placeholders instead of overlay
  showCanvasPlaceholders();
}

function hideDragOverlay() {
  // Now using canvas placeholders instead of overlay
  hideCanvasPlaceholders();
}

function showDropSuccess(targetCanvas) {
  // Create temporary success indicator
  const successIndicator = document.createElement('div');
  successIndicator.className = 'drop-success';
  const frameName = targetCanvas === 'start' ? 'Start' : 'End';
  successIndicator.innerHTML = `
    <div class="success-icon">✅</div>
    <div class="success-text">Image added as ${frameName} Frame!</div>
  `;
  
  document.body.appendChild(successIndicator);
  
  // Remove after animation
  setTimeout(() => {
    successIndicator.remove();
  }, 2000);
}

function updateFileDisplay(file) {
  const promptFiles = document.getElementById('promptFiles');
  const fileTag = document.createElement('div');
  fileTag.className = 'file-tag';
  fileTag.innerHTML = `
    ${file.name.substring(0, 8)}...
    <span class="remove" onclick="removeFileAttachment(this)">×</span>
  `;
  fileTag.dataset.fileName = file.name;
  promptFiles.appendChild(fileTag);
}

function removeFileAttachment(element) {
  const fileTag = element.parentElement;
  const fileName = fileTag.dataset.fileName;
  
  // Remove from uploadedFiles array
  // Note: This is a simplified removal - in production you might want better tracking
  uploadedFiles.pop(); // Remove last uploaded file
  
  // Remove from DOM
  fileTag.remove();
}

// Generate Image for Active Canvas using Seedream-3
// Convert canvas to cropped image blob
function canvasToBlob(canvas) {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, 'image/png');
  });
}

// Crop from original source image to the target aspect ratio, keeping max native resolution (no downscale)
async function uploadCroppedSourceToReplicate(slot /* 'start' | 'end' */) {
  let displayUrl = slot === 'start' ? canvasDisplayImages.start : canvasDisplayImages.end;
  // Fallback to replicate URL if display URL is not available
  if (!displayUrl) {
    displayUrl = slot === 'start' ? canvasImages.start : canvasImages.end;
  }
  if (!displayUrl) throw new Error('No image to crop for ' + slot);
  const [ratioW, ratioH] = globalAspectRatio.split(':').map(Number);
  const targetAR = ratioW / ratioH;

  // Load original image at native resolution
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.crossOrigin = 'anonymous';
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = displayUrl;
  });

  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  const srcAR = srcW / srcH;

  let cropW, cropH, cropX, cropY;
  if (srcAR > targetAR) {
    // Source wider than target -> crop width
    cropH = srcH;
    cropW = Math.round(cropH * targetAR);
    cropX = Math.round((srcW - cropW) / 2);
    cropY = 0;
  } else {
    // Source taller than target -> crop height
    cropW = srcW;
    cropH = Math.round(cropW / targetAR);
    cropX = 0;
    cropY = Math.round((srcH - cropH) / 2);
  }

  // Create offscreen canvas with the cropped native size (no scaling)
  const off = document.createElement('canvas');
  off.width = cropW;
  off.height = cropH;
  const offCtx = off.getContext('2d');
  offCtx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

  // Encode as PNG to avoid quality loss
  const blob = await new Promise((resolve) => off.toBlob(resolve, 'image/png'));
  const file = new File([blob], `cropped-${slot}.png`, { type: 'image/png' });
  return await replicateUpload(file);
}

async function generateImageForActiveCanvas(prompt) {
  const playBtn = document.getElementById('playBtn');
  const canvasFrame = activeCanvas === 'start' ? 
    document.getElementById('startFrame') : 
    document.getElementById('endFrame');
  
  try {
    // Show loading states
    showButtonLoading(playBtn, 'Gerando...');
    showCanvasLoading(canvasFrame);
    
    // Use highest quality available for Seedream-3 image generation
    const input = { 
      prompt, 
      aspect_ratio: globalAspectRatio,
      // override to highest quality allowed by model enum
      size: 'big',
      guidance_scale: 2.5
    };
    
    // If we have attachments, use them as reference images
    if (uploadedFiles.length > 0) {
      input.image = uploadedFiles[uploadedFiles.length - 1]; // Use latest uploaded image
      console.log('Using attachment as reference:', input.image);
    }
    
    console.log('Generating image with Seedream-3...', input);
    const outputs = await replicateRun('bytedance/seedream-3', input);
    const imageUrl = Array.isArray(outputs) ? outputs[0] : outputs;
    
    // Add generated image to active canvas
    if (activeCanvas === 'start') {
      await drawImageOnCanvas(canvasStart, ctxStart, imageUrl, false);
      canvasImages.start = imageUrl;
      canvasDisplayImages.start = imageUrl;
    } else {
      await drawImageOnCanvas(canvasEnd, ctxEnd, imageUrl, false);
      canvasImages.end = imageUrl;
      canvasDisplayImages.end = imageUrl;
    }
    
    addToHistory(imageUrl);
    // Fade-in + final shimmer
    const target = activeCanvas === 'start' ? canvasStart : canvasEnd;
    target.classList.add('canvas-fade-in');
    showFinalShimmerEffect(target);
    updateUIState();
    
    console.log('Image generated successfully:', imageUrl);
    
  } catch (err) {
    console.error('Error generating image:', err);
    alert('Erro ao gerar imagem: ' + err.message);
  } finally {
    // Hide loading states
    hideButtonLoading(playBtn);
    hideCanvasLoading(canvasFrame);
  }
}

// Edit Image using Nano-Banana
async function editImage(prompt) {
  const canvasFrame = activeCanvas === 'start' ? 
    document.getElementById('startFrame') : 
    document.getElementById('endFrame');
    
  try {
    // Show loading state
    showCanvasLoading(canvasFrame);
    
    // Get the active canvas and upload its cropped content
    const croppedImageUrl = await uploadCroppedSourceToReplicate(activeCanvas);
    
    // Highest quality settings for Nano-Banana (if supported)
    const input = {
      prompt,
      image_input: [croppedImageUrl],
      output_format: 'png',
      quality: 'high',
      upscale: true
    };
    
    const outputs = await replicateRun('google/nano-banana', input);
    const imageUrl = Array.isArray(outputs) ? outputs[0] : outputs;
    
    return imageUrl;
  } catch (err) {
    alert('Erro ao editar imagem: ' + err.message);
    return null;
  } finally {
    // Hide loading state
    hideCanvasLoading(canvasFrame);
  }
}

// Generate Video using Seedance-1-lite
async function generateVideo(prompt) {
  const playBtn = document.getElementById('playBtn');
  const videoPreview = document.getElementById('videoPreview');
  const videoPlayer = document.getElementById('videoPlayer');
  const durationInput = document.getElementById('videoDuration');
  
  try {
    // Permitimos 1 frame só: se houver apenas uma imagem, duplicamos para start/end
    const hasStart = !!(canvasDisplayImages.start || canvasImages.start);
    const hasEnd = !!(canvasDisplayImages.end || canvasImages.end);
    if (!hasStart && !hasEnd) {
      alert('Para gerar vídeo, adicione pelo menos uma imagem.');
      return;
    }
    
    // Show loading states
    showButtonLoading(playBtn, 'Gerando vídeo...');
    showGlobalLoading(videoPreview, 'Gerando vídeo...');
    
    // Upload cropped canvas images to Replicate (sem duplicação)
    let startImageUrl = null;
    let endImageUrl = null;
    if (hasStart) {
      startImageUrl = await uploadCroppedSourceToReplicate('start');
    }
    if (hasEnd) {
      endImageUrl = await uploadCroppedSourceToReplicate('end');
    }
    
    // Map resolution for video
    const videoResolution = globalResolution === 'big' ? '1080p' : 
                           globalResolution === 'small' ? '480p' : '720p';
    
    const input = {
      prompt,
      duration: Math.min(Math.max(parseInt(durationInput?.value || '5', 10), 1), 10),
      resolution: videoResolution,
      aspect_ratio: globalAspectRatio,
      camera_fixed: false
    };
    if (startImageUrl) input.image = startImageUrl;
    if (endImageUrl) input.last_frame_image = endImageUrl;
    
    console.log('Generating video with Seedance-1-lite...', input);
    const outputs = await replicateRun('bytedance/seedance-1-lite', input);
    const videoUrl = Array.isArray(outputs) ? outputs[0] : outputs;
    
    // Show video with current dimensions; and fix size as last output
    videoPlayer.src = videoUrl;
    videoPlayer.loop = true;
    videoPlayer.muted = true;
    videoPlayer.play().catch(() => {});
    currentVideo = videoUrl;
    if (videoPlayer.videoWidth && videoPlayer.videoHeight) {
      lastVideoSize = { width: videoPlayer.clientWidth, height: videoPlayer.clientHeight };
    } else {
      // After metadata loads, capture size
      videoPlayer.onloadedmetadata = () => {
        lastVideoSize = { width: videoPlayer.clientWidth, height: videoPlayer.clientHeight };
      };
    }
    
    console.log('Video generated successfully:', videoUrl);
    updateUIState();
    
  } catch (err) {
    console.error('Error generating video:', err);
    alert('Erro ao gerar vídeo: ' + err.message);
  } finally {
    // Hide loading states
    hideButtonLoading(playBtn);
    hideGlobalLoading(videoPreview);
  }
}

// Legacy code removed - now using simplified UI functions above


