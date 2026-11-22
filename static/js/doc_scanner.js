/**
 * PrintSafe Cloud — Full Adobe Scan-Style Document Scanner Suite (v9.0)
 * File: static/js/doc_scanner.js
 */
(function () {
  "use strict";

  const PAGE_SIZE_CATALOG = [
    { id: "auto", label: "Auto fit", w: 210, h: 297, orient: "p", icon: "auto" },
    { id: "a4-p", label: "A4 portrait", w: 210, h: 297, orient: "p", icon: "doc-p" },
    { id: "a4-l", label: "A4 landscape", w: 297, h: 210, orient: "l", icon: "doc-l" },
    { id: "a3-p", label: "A3 portrait", w: 297, h: 420, orient: "p", icon: "doc-p-lg" },
    { id: "a3-l", label: "A3 landscape", w: 420, h: 297, orient: "l", icon: "doc-l-lg" },
    { id: "a5-p", label: "A5 portrait", w: 148, h: 210, orient: "p", icon: "doc-p-sm" },
    { id: "a5-l", label: "A5 landscape", w: 210, h: 148, orient: "l", icon: "doc-l-sm" },
    { id: "letter-p", label: "Letter portrait", w: 215.9, h: 279.4, orient: "p", icon: "doc-p" },
    { id: "letter-l", label: "Letter landscape", w: 279.4, h: 215.9, orient: "l", icon: "doc-l" },
    { id: "legal-p", label: "Legal portrait", w: 215.9, h: 355.6, orient: "p", icon: "doc-p-lg" },
    { id: "legal-l", label: "Legal landscape", w: 355.6, h: 215.9, orient: "l", icon: "doc-l-lg" },
    { id: "card", label: "Business card", w: 85.6, h: 54, orient: "l", icon: "doc-l-sm" }
  ];

  const FILTER_CATALOG = [
    { id: "original", label: "Original color" },
    { id: "magic", label: "Auto-color" },
    { id: "vintage", label: "Vintage look" },
    { id: "light_text", label: "Light text" },
    { id: "crumpled", label: "Crumpled" },
    { id: "warm", label: "Warm color" },
    { id: "cool", label: "Cool color" },
    { id: "grayscale", label: "Grayscale" },
    { id: "whiteboard", label: "Whiteboard" }
  ];

  const Scanner = {
    pages: [],
    activeIndex: 0,
    viewMode: "camera",
    activeTool: null,
    toolSnapshot: null,
    undoStack: [],
    redoStack: [],
    adjustMetric: "contrast",
    applyToAllPages: false,
    isThumbsOpen: false,
    scanPreset: "Document",
    autoCaptureEnabled: true,
    torchEnabled: false,
    markupColor: "#2563eb",
    pageSizePreset: "auto",

    // Cleanup state
    cleanupMode: "surrounding",
    cleanupSelectedColor: "#ffffff",
    cleanupBrushSize: 28,
    isEyedropperActive: false,

    // Camera & Auto-Capture stability state
    mediaStream: null,
    imageCaptureObj: null,
    detectRafId: null,
    stableFrames: 0,
    lastLiveQuad: null,
    isCapturingFrame: false,
    awaitingSceneChangeAfterCapture: false,
    lastCapturedQuadSignature: null,

    draggingHandleIndex: -1,
    isDrawingStroke: false,
    targetFolderCtx: null,
    docTitle: "",

    _resolveCurrentFolderContext() {
      if (typeof getActiveUploadFolderContext === "function") {
        const ctx = getActiveUploadFolderContext();
        if (ctx && (ctx.cloud_id || ctx.storage_id || ctx.account_id)) return ctx;
      }

      const tree = typeof globalVaultTree !== "undefined" ? globalVaultTree : [];
      if (Array.isArray(currentFolderNavigation) && currentFolderNavigation.length > 0) {
        let walker = tree;
        let resolved = null;
        let inhProv = "", inhAcc = "", inhAccName = "", inhStor = "";

        for (const seg of currentFolderNavigation) {
          const match = walker.find((n) => n.type === "folder" && n.name === seg);
          if (!match) break;
          if (match.provider) inhProv = String(match.provider).toLowerCase();
          if (match.account_id) inhAcc = match.account_id;
          if (match.account_name) inhAccName = match.account_name;
          if (match.storage_id) inhStor = match.storage_id;

          resolved = {
            name: match.name,
            provider: (match.provider || inhProv || "google").toLowerCase(),
            cloud_id: match.cloud_id || "",
            account_id: match.account_id || inhAcc || "",
            account_name: match.account_name || inhAccName || "",
            storage_id: match.storage_id || inhStor || "",
            remote_path: match.remote_path || "/"
          };
          walker = match.children || [];
        }
        if (resolved && (resolved.cloud_id || resolved.storage_id || resolved.account_id)) {
          return resolved;
        }
      }

      const firstMounted = tree.find((n) => n.type === "folder" && !n.is_expired && (n.cloud_id || n.storage_id || n.account_id));
      if (firstMounted) {
        return {
          name: firstMounted.name,
          provider: (firstMounted.provider || "google").toLowerCase(),
          cloud_id: firstMounted.cloud_id || "root",
          account_id: firstMounted.account_id || "",
          account_name: firstMounted.account_name || "",
          storage_id: firstMounted.storage_id || "",
          remote_path: firstMounted.remote_path || "/"
        };
      }
      return null;
    },

    _cloneCanvas(src) {
      if (!src) return null;
      const c = document.createElement("canvas");
      c.width = src.width;
      c.height = src.height;
      c.getContext("2d").drawImage(src, 0, 0);
      return c;
    },

    _captureFullSnapshot() {
      return {
        activeIndex: this.activeIndex,
        pageSizePreset: this.pageSizePreset,
        pages: this.pages.map((p) => ({
          id: p.id,
          rawCanvas: this._cloneCanvas(p.rawCanvas),
          workingCanvas: this._cloneCanvas(p.workingCanvas),
          cleanupLayer: this._cloneCanvas(p.cleanupLayer),
          markupLayer: this._cloneCanvas(p.markupLayer),
          textStamps: JSON.parse(JSON.stringify(p.textStamps || [])),
          corners: JSON.parse(JSON.stringify(p.corners || [])),
          filter: p.filter,
          brightness: p.brightness || 0,
          contrast: p.contrast || 0,
          isCropped: Boolean(p.isCropped)
        }))
      };
    },

    _restoreFullSnapshot(snap) {
      if (!snap) return;
      if (snap.pageSizePreset) this.pageSizePreset = snap.pageSizePreset;
      this.activeIndex = Math.min(snap.activeIndex, Math.max(0, snap.pages.length - 1));
      this.pages = snap.pages.map((p) => {
        const restored = {
          id: p.id,
          rawCanvas: this._cloneCanvas(p.rawCanvas),
          workingCanvas: this._cloneCanvas(p.workingCanvas),
          cleanupLayer: this._cloneCanvas(p.cleanupLayer),
          markupLayer: this._cloneCanvas(p.markupLayer),
          textStamps: JSON.parse(JSON.stringify(p.textStamps || [])),
          corners: JSON.parse(JSON.stringify(p.corners || [])),
          filter: p.filter,
          brightness: p.brightness || 0,
          contrast: p.contrast || 0,
          isCropped: Boolean(p.isCropped),
          processedCanvas: null,
          processedDataUrl: null
        };
        this._processPagePipeline(restored);
        return restored;
      });
      this._updateUndoRedoButtons();
      this.updatePageCounterUI();
      this.renderThumbnails();
      this.renderActiveCanvas();
    },

    _pushUndoState() {
      this.undoStack.push(this._captureFullSnapshot());
      if (this.undoStack.length > 15) this.undoStack.shift();
      this.redoStack = [];
      this._updateUndoRedoButtons();
    },

    undo() {
      if (!this.undoStack.length) return;
      this.redoStack.push(this._captureFullSnapshot());
      const prev = this.undoStack.pop();
      this._restoreFullSnapshot(prev);
      if (this.activeTool) this._syncSubpanelUI(this.activeTool);
    },

    redo() {
      if (!this.redoStack.length) return;
      this.undoStack.push(this._captureFullSnapshot());
      const next = this.redoStack.pop();
      this._restoreFullSnapshot(next);
      if (this.activeTool) this._syncSubpanelUI(this.activeTool);
    },

    _updateUndoRedoButtons() {
      const uBtn = document.getElementById("ps-undo-btn");
      const rBtn = document.getElementById("ps-redo-btn");
      if (uBtn) {
        uBtn.disabled = this.undoStack.length === 0;
        uBtn.style.opacity = this.undoStack.length === 0 ? "0.4" : "1";
      }
      if (rBtn) {
        rBtn.disabled = this.redoStack.length === 0;
        rBtn.style.opacity = this.redoStack.length === 0 ? "0.4" : "1";
      }
    },

    _getResizeSvgIcon(iconType) {
      if (iconType === "auto") {
        return `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <rect x="4" y="4" width="16" height="16" rx="1.5"/>
          <rect x="7" y="7" width="10" height="10" rx="1"/>
          <circle cx="10" cy="10" r="1" fill="currentColor"/>
          <path d="M7.5 15.5l2.5-2.5 2 2 2-2.5 2.5 3"/>
        </svg>`;
      }
      if (iconType === "doc-p" || iconType === "doc-p-lg" || iconType === "doc-p-sm") {
        const scale = iconType === "doc-p-lg" ? "1.08" : iconType === "doc-p-sm" ? "0.86" : "0.96";
        return `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="transform:scale(${scale})">
          <path d="M6 3h8l4 4v14H6V3z"/>
          <path d="M14 3v4h4"/>
        </svg>`;
      }
      const scaleL = iconType === "doc-l-lg" ? "1.08" : iconType === "doc-l-sm" ? "0.86" : "0.96";
      return `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="transform:scale(${scaleL})">
        <path d="M3 6h14l4 4v8H3V6z"/>
        <path d="M17 6v4h4"/>
      </svg>`;
    },

    _buildFreshModal() {
      document.querySelectorAll("#ps-scanner-modal").forEach((el) => el.remove());

      const resizeCardsHtml = PAGE_SIZE_CATALOG.map(
        (sz) => `
          <button type="button" class="ps-resize-card ${sz.id === this.pageSizePreset ? "active" : ""}" data-size="${sz.id}" onclick="PrintSafeScanner.setPageSize('${sz.id}', this)">
            <div class="ps-resize-icon">${this._getResizeSvgIcon(sz.icon)}</div>
            <div class="ps-resize-lbl">${sz.label}</div>
          </button>
        `
      ).join("");

      const wrapper = document.createElement("div");
      wrapper.innerHTML = `
        <div id="ps-scanner-modal" class="ps-scanner-overlay" style="display:none;">
          <div class="ps-scanner-shell">

            <!-- VIEW 1: CONTINUOUS LIVE CAMERA SCANNER -->
            <div id="ps-camera-stage" class="ps-camera-stage">
              <div class="ps-cam-top-overlay">
                <button type="button" class="ps-cam-circle-btn" onclick="PrintSafeScanner.close()" title="Close Scanner">
                  <i class="ri-home-5-fill"></i>
                </button>
                <div class="ps-cam-dest-badge">
                  <i class="ri-folder-3-fill"></i>
                  <span id="ps-cam-dest-name">Current Folder</span>
                </div>
                <button type="button" class="ps-cam-circle-btn" onclick="PrintSafeScanner.openReviewWorkspace()" title="Review Scanned Pages">
                  <i class="ri-gallery-view-2"></i>
                </button>
              </div>

              <div class="ps-video-viewport" id="ps-video-viewport">
                <video id="ps-live-video" autoplay playsinline muted></video>
                <canvas id="ps-live-overlay"></canvas>

                <!-- Tap-to-Focus Reticle Ring -->
                <div id="ps-focus-reticle" class="ps-focus-reticle" style="display:none;">
                  <div class="ps-focus-inner"></div>
                </div>

                <div id="ps-book-split-guide" class="ps-book-split-guide" style="display:none;">
                  <span class="ps-book-num left">1</span>
                  <div class="ps-book-dashed-line"></div>
                  <span class="ps-book-num right">2</span>
                  <div class="ps-book-order-pill" id="ps-book-order-pill" onclick="PrintSafeScanner.toggleBookOrder()">1 ⇄ 2</div>
                </div>

                <div id="ps-steady-pill" class="ps-steady-pill" style="display:none;">
                  Focusing &amp; capturing... hold steady
                </div>

                <div id="ps-capture-flash" class="ps-capture-flash"></div>
                <div id="ps-scan-laser-beam" class="ps-scan-laser-beam"></div>

                <div id="ps-camera-fallback" class="ps-camera-fallback" style="display:none;">
                  <i class="ri-camera-lens-line" style="font-size:40px; color:var(--accent); margin-bottom:8px;"></i>
                  <div style="font-weight:800; font-size:15px; color:var(--text-title);">Camera Access</div>
                  <p id="ps-cam-err-msg" style="font-size:12px; color:var(--text-sub); max-width:270px; margin:6px 0 14px 0;">
                    Tap below to capture with device camera or select photos from gallery.
                  </p>
                  <div style="display:flex; gap:8px;">
                    <button type="button" class="ps-btn-primary" onclick="document.getElementById('ps-scan-cam-input').click()">
                      <i class="ri-camera-fill"></i> Open Camera
                    </button>
                    <button type="button" class="ps-tool-pill" onclick="document.getElementById('ps-scan-gallery-input').click()">
                      <i class="ri-image-add-line"></i> Gallery
                    </button>
                  </div>
                </div>
              </div>

              <div class="ps-mode-strip">
                <button type="button" class="ps-mode-tab" data-mode="Whiteboard" onclick="PrintSafeScanner.setPreset('Whiteboard')">Whiteboard</button>
                <button type="button" class="ps-mode-tab" data-mode="Book" onclick="PrintSafeScanner.setPreset('Book')">Book</button>
                <button type="button" class="ps-mode-tab active" data-mode="Document" onclick="PrintSafeScanner.setPreset('Document')">Document</button>
                <button type="button" class="ps-mode-tab" data-mode="ID card" onclick="PrintSafeScanner.setPreset('ID card')">ID card</button>
                <button type="button" class="ps-mode-tab" data-mode="Business" onclick="PrintSafeScanner.setPreset('Business')">Business</button>
              </div>

              <div class="ps-shutter-deck">
                <button type="button" class="ps-deck-action" onclick="document.getElementById('ps-scan-gallery-input').click()" title="Add Image">
                  <i class="ri-image-2-line"></i>
                </button>
                <button type="button" class="ps-deck-action active" id="ps-auto-cap-btn" onclick="PrintSafeScanner.toggleAutoCapture()" title="Auto-Capture">
                  <i class="ri-sparkling-2-line"></i>
                </button>
                <button type="button" class="ps-shutter-ring" id="ps-shutter-ring" onclick="PrintSafeScanner.captureFromVideo(true)" title="Capture HD Page">
                  <svg class="ps-shutter-svg" viewBox="0 0 72 72">
                    <circle cx="36" cy="36" r="32" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="4" />
                    <circle id="ps-shutter-arc" cx="36" cy="36" r="32" fill="none" stroke="#38bdf8" stroke-width="4"
                            stroke-dasharray="201" stroke-dashoffset="201" stroke-linecap="round"
                            transform="rotate(-90 36 36)" />
                  </svg>
                  <span class="ps-shutter-core"></span>
                </button>
                <button type="button" class="ps-deck-action" id="ps-torch-btn" onclick="PrintSafeScanner.toggleTorch()" title="Flash">
                  <i class="ri-flashlight-line"></i>
                </button>
                <button type="button" class="ps-thumb-stack-btn" onclick="PrintSafeScanner.openReviewWorkspace()" title="Review Scan">
                  <img id="ps-last-thumb-img" src="" alt="" style="display:none;" />
                  <i id="ps-empty-stack-icon" class="ri-file-copy-2-line" style="color:var(--text-sub); font-size:18px;"></i>
                  <span id="ps-page-badge" class="ps-page-badge">0</span>
                </button>
              </div>

              <input id="ps-scan-cam-input" type="file" accept="image/*" capture="environment" style="display:none;" />
              <input id="ps-scan-gallery-input" type="file" accept="image/*" multiple style="display:none;" />
            </div>

            <!-- VIEW 2: FULLSCREEN REVIEW & EDIT STAGE -->
            <div id="ps-review-stage" class="ps-review-stage" style="display:none;">
              
              <!-- Top Header with Undo / Redo -->
              <div class="ps-rev-topbar">
                <button type="button" class="ps-top-icon-btn" onclick="PrintSafeScanner.close()" title="Close">
                  <i class="ri-home-5-fill"></i>
                </button>

                <div class="ps-rev-title-box" onclick="document.getElementById('ps-scan-filename').focus()">
                  <input id="ps-scan-filename" type="text" class="ps-rev-title-input" value="PrintSafe_Scan" />
                  <i class="ri-pencil-line" style="color:var(--text-sub); font-size:14px;"></i>
                </div>

                <div style="display:flex; align-items:center; gap:5px;">
                  <button type="button" id="ps-undo-btn" class="ps-top-icon-btn" onclick="PrintSafeScanner.undo()" title="Undo" disabled style="opacity:0.4;">
                    <i class="ri-arrow-go-back-line"></i>
                  </button>
                  <button type="button" id="ps-redo-btn" class="ps-top-icon-btn" onclick="PrintSafeScanner.redo()" title="Redo" disabled style="opacity:0.4;">
                    <i class="ri-arrow-go-forward-line"></i>
                  </button>
                </div>
              </div>

              <!-- Document Preview Stage -->
              <div class="ps-rev-canvas-stage">
                <canvas id="ps-scan-canvas"></canvas>
              </div>

              <!-- Page Navigation Pill -->
              <div class="ps-page-nav-bar">
                <button type="button" class="ps-nav-arrow-btn" onclick="PrintSafeScanner.prevPage()" title="Previous Page">
                  <i class="ri-arrow-left-s-line"></i>
                </button>
                <button type="button" class="ps-page-indicator-pill" id="ps-page-indicator-pill" onclick="PrintSafeScanner.toggleThumbsDrawer()">
                  <span>Page 1 of 1</span>
                  <i class="ri-arrow-down-s-line" id="ps-page-pill-chevron"></i>
                </button>
                <button type="button" class="ps-nav-arrow-btn" onclick="PrintSafeScanner.nextPage()" title="Next Page">
                  <i class="ri-arrow-right-s-line"></i>
                </button>
              </div>

              <!-- Collapsible Thumbnail Strip -->
              <div id="ps-scan-thumbs" class="ps-rev-thumbs-strip" style="display:none;"></div>

              <!-- EXCLUSIVE TOOL SUB-PANEL -->
              <div id="ps-tool-subpanel" class="ps-tool-subpanel" style="display:none;">
                <div class="ps-subpanel-topbar">
                  <button type="button" class="ps-sub-nav-btn back" onclick="PrintSafeScanner.cancelActiveTool()" title="Back">
                    <i class="ri-arrow-left-line"></i> Back
                  </button>
                  <span class="ps-subpanel-title" id="ps-subpanel-title">Tool</span>
                  <button type="button" class="ps-sub-nav-btn done" onclick="PrintSafeScanner.confirmActiveTool()" title="Done">
                    <i class="ri-check-line"></i>
                  </button>
                </div>

                <!-- 1. Crop Sub-Panel -->
                <div id="ps-sub-crop" class="ps-sub-row" style="display:none;">
                  <button type="button" class="ps-sub-chip" onclick="PrintSafeScanner.reRunAutoDetect()">
                    <i class="ri-focus-3-line"></i> Auto-detect
                  </button>
                  <button type="button" class="ps-sub-chip" onclick="PrintSafeScanner.setNoCrop()">
                    <i class="ri-fullscreen-line"></i> No crop
                  </button>
                </div>

                <!-- 2. All 9 Visual Filters Sub-Panel -->
                <div id="ps-sub-filters" class="ps-filters-visual-panel" style="display:none;">
                  <div class="ps-filter-cards-scroll" id="ps-filter-cards-grid"></div>
                  <label class="ps-apply-all-row">
                    <input type="checkbox" class="ps-toggle-chk" onchange="PrintSafeScanner.toggleApplyToAll(this.checked)" />
                    <span>Apply to All Pages</span>
                  </label>
                </div>

                <!-- 3. Adjust Brightness / Contrast Panel -->
                <div id="ps-sub-adjust" class="ps-adjust-box" style="display:none;">
                  <div class="ps-adj-tabs">
                    <button type="button" class="ps-adj-tab" id="ps-adj-tab-brightness" onclick="PrintSafeScanner.selectAdjustMetric('brightness')">
                      <i class="ri-sun-line"></i> Brightness
                    </button>
                    <button type="button" class="ps-adj-tab active" id="ps-adj-tab-contrast" onclick="PrintSafeScanner.selectAdjustMetric('contrast')">
                      <i class="ri-contrast-line"></i> Contrast
                    </button>
                  </div>
                  <div class="ps-adj-slider-header">
                    <span id="ps-adj-metric-label">Contrast</span>
                    <span id="ps-adj-metric-val">0</span>
                  </div>
                  <input type="range" id="ps-adj-slider" min="-60" max="60" value="0" class="ps-adj-slider" oninput="PrintSafeScanner.onAdjustSliderChange(this.value)" />
                  <label class="ps-apply-all-row">
                    <input type="checkbox" class="ps-toggle-chk" onchange="PrintSafeScanner.toggleApplyToAll(this.checked)" />
                    <span>Apply to All Pages</span>
                  </label>
                </div>

                <!-- 4. Markup / Draw Pen Sub-Panel -->
                <div id="ps-sub-markup" class="ps-sub-row" style="display:none;">
                  <button type="button" class="ps-color-dot active" style="background:#2563eb;" onclick="PrintSafeScanner.setMarkupColor('#2563eb', this)"></button>
                  <button type="button" class="ps-color-dot" style="background:#ef4444;" onclick="PrintSafeScanner.setMarkupColor('#ef4444', this)"></button>
                  <button type="button" class="ps-color-dot" style="background:#16a34a;" onclick="PrintSafeScanner.setMarkupColor('#16a34a', this)"></button>
                  <button type="button" class="ps-color-dot" style="background:#facc15;" onclick="PrintSafeScanner.setMarkupColor('#facc15', this)"></button>
                  <button type="button" class="ps-color-dot" style="background:#0f172a;" onclick="PrintSafeScanner.setMarkupColor('#0f172a', this)"></button>
                  <button type="button" class="ps-sub-chip" onclick="PrintSafeScanner.clearMarkupLayer()">Clear Ink</button>
                </div>

                <!-- 5. Edit Text Annotation Sub-Panel -->
                <div id="ps-sub-text" class="ps-sub-row" style="display:none;">
                  <input id="ps-text-stamp-input" type="text" class="ps-mini-text-input" placeholder="Type text to stamp on page..." />
                  <button type="button" class="ps-sub-chip primary" onclick="PrintSafeScanner.addTextAnnotation()">
                    <i class="ri-add-line"></i> Add
                  </button>
                  <button type="button" class="ps-sub-chip" onclick="PrintSafeScanner.clearTextAnnotations()">Clear</button>
                </div>

                <!-- 6. Smart Cleanup Panel -->
                <div id="ps-sub-cleanup" class="ps-cleanup-panel" style="display:none;">
                  <div class="ps-cleanup-heading">Replacement Color</div>
                  <label class="ps-cleanup-radio-row">
                    <input type="radio" name="ps-cleanup-mode" value="surrounding" checked onchange="PrintSafeScanner.setCleanupMode('surrounding')" />
                    <span>Fill with surrounding color</span>
                  </label>
                  <div class="ps-cleanup-selected-row">
                    <label class="ps-cleanup-radio-row" style="flex:1;">
                      <input type="radio" name="ps-cleanup-mode" value="selected" onchange="PrintSafeScanner.setCleanupMode('selected')" />
                      <span>Fill with selected color</span>
                    </label>
                    <input type="color" id="ps-cleanup-color-swatch" value="#ffffff" class="ps-cleanup-swatch" onchange="PrintSafeScanner.setCleanupSelectedColor(this.value)" title="Choose Replacement Color" />
                    <button type="button" id="ps-cleanup-eyedropper-btn" class="ps-cleanup-eyedropper" onclick="PrintSafeScanner.activateEyedropper()" title="Pick Color from Page">
                      <i class="ri-sip-line"></i>
                    </button>
                  </div>
                  <div class="ps-cleanup-size-row">
                    <div style="display:flex; justify-content:space-between; font-size:12px; font-weight:700; color:var(--text-sub);">
                      <span>Size</span>
                      <span id="ps-cleanup-size-val">28</span>
                    </div>
                    <div style="display:flex; align-items:center; gap:10px;">
                      <input type="range" id="ps-cleanup-size-slider" min="8" max="80" value="28" class="ps-adj-slider" style="flex:1;" oninput="PrintSafeScanner.setCleanupSize(this.value)" />
                      <button type="button" class="ps-sub-chip" onclick="PrintSafeScanner.resetCleanup()">Reset</button>
                    </div>
                  </div>
                </div>

                <!-- 7. Resize Page Strip -->
                <div id="ps-sub-resize" class="ps-resize-strip" style="display:none;">
                  ${resizeCardsHtml}
                </div>

                <!-- 8. Reorder Pages Sub-Panel -->
                <div id="ps-sub-reorder" class="ps-sub-row" style="display:none;">
                  <button type="button" class="ps-sub-chip" onclick="PrintSafeScanner.moveActivePage(-1)">
                    <i class="ri-arrow-left-line"></i> Move Earlier
                  </button>
                  <span style="font-size:12px; font-weight:700; color:var(--text-title);" id="ps-reorder-label">Page 1</span>
                  <button type="button" class="ps-sub-chip" onclick="PrintSafeScanner.moveActivePage(1)">
                    Move Later <i class="ri-arrow-right-line"></i>
                  </button>
                </div>
              </div>

              <!-- BOTTOM TOOLS DOCK -->
              <div id="ps-rev-tools-dock" class="ps-rev-tools-dock">
                <button type="button" class="ps-rev-tool-btn" onclick="PrintSafeScanner.retakeActivePage()">
                  <i class="ri-camera-switch-line"></i>
                  <span>Retake</span>
                </button>
                <button type="button" class="ps-rev-tool-btn" data-tool="crop" onclick="PrintSafeScanner.openToolSubpanel('crop')">
                  <i class="ri-crop-2-line"></i>
                  <span>Crop</span>
                </button>
                <button type="button" class="ps-rev-tool-btn" onclick="PrintSafeScanner.rotateActive(90)">
                  <i class="ri-clockwise-line"></i>
                  <span>Rotate</span>
                </button>
                <button type="button" class="ps-rev-tool-btn" data-tool="filters" onclick="PrintSafeScanner.openToolSubpanel('filters')">
                  <i class="ri-contrast-drop-2-line"></i>
                  <span>Filters</span>
                </button>
                <button type="button" class="ps-rev-tool-btn" data-tool="adjust" onclick="PrintSafeScanner.openToolSubpanel('adjust')">
                  <i class="ri-sun-line"></i>
                  <span>Adjust</span>
                </button>
                <button type="button" class="ps-rev-tool-btn" data-tool="markup" onclick="PrintSafeScanner.openToolSubpanel('markup')">
                  <i class="ri-markup-line"></i>
                  <span>Markup</span>
                </button>
                <button type="button" class="ps-rev-tool-btn" data-tool="text" onclick="PrintSafeScanner.openToolSubpanel('text')">
                  <i class="ri-edit-box-line"></i>
                  <span>Edit text</span>
                </button>
                <button type="button" class="ps-rev-tool-btn" data-tool="cleanup" onclick="PrintSafeScanner.openToolSubpanel('cleanup')">
                  <i class="ri-eraser-line"></i>
                  <span>Cleanup</span>
                </button>
                <button type="button" class="ps-rev-tool-btn" data-tool="resize" onclick="PrintSafeScanner.openToolSubpanel('resize')">
                  <i class="ri-aspect-ratio-line"></i>
                  <span>Resize</span>
                </button>
                <button type="button" class="ps-rev-tool-btn" data-tool="reorder" onclick="PrintSafeScanner.openToolSubpanel('reorder')">
                  <i class="ri-arrow-left-right-line"></i>
                  <span>Reorder</span>
                </button>
                <button type="button" class="ps-rev-tool-btn danger" onclick="PrintSafeScanner.deleteActivePage()">
                  <i class="ri-delete-bin-line"></i>
                  <span>Delete</span>
                </button>
              </div>

              <!-- Bottom Dual Save Footer -->
              <div class="ps-rev-save-footer">
                <button type="button" class="ps-keep-scanning-btn" onclick="PrintSafeScanner.switchToCamera()">
                  Keep scanning
                </button>
                <div class="ps-save-btns-group">
                  <button type="button" id="ps-save-images-btn" class="ps-save-img-btn" onclick="PrintSafeScanner.exportAndUploadImages()">
                    <i class="ri-image-2-line"></i> Save Images
                  </button>
                  <button type="button" id="ps-save-pdf-btn" class="ps-save-pdf-btn" onclick="PrintSafeScanner.exportAndUploadPdf()">
                    <i class="ri-file-pdf-2-line"></i> Save PDF
                  </button>
                </div>
              </div>

            </div>

          </div>
        </div>
      `;

      document.body.appendChild(wrapper.firstElementChild);
      this._bindEvents();
      return document.getElementById("ps-scanner-modal");
    },

    open(preselectedFolderCtx = null) {
      const modal = this._buildFreshModal();
      if (!modal) return;

      this.pages = [];
      this.activeIndex = 0;
      this.activeTool = null;
      this.toolSnapshot = null;
      this.undoStack = [];
      this.redoStack = [];
      this.isThumbsOpen = false;
      this.bookOrderReversed = false;
      this.awaitingSceneChangeAfterCapture = false;
      this.lastCapturedQuadSignature = null;
      this.targetFolderCtx = preselectedFolderCtx || this._resolveCurrentFolderContext();

      const destEl = document.getElementById("ps-cam-dest-name");
      if (destEl) {
        destEl.textContent = this.targetFolderCtx ? this.targetFolderCtx.name : "Select a Folder First";
      }

      const now = new Date();
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
      this.docTitle = `PrintSafe_Scan_${stamp}`;
      const fnInput = document.getElementById("ps-scan-filename");
      if (fnInput) fnInput.value = this.docTitle;

      modal.style.setProperty("display", "flex", "important");
      modal.classList.add("open");
      this.switchToCamera();
    },

    close() {
      this._stopCameraStream();
      const modal = document.getElementById("ps-scanner-modal");
      if (modal) {
        modal.classList.remove("open");
        modal.style.setProperty("display", "none", "important");
      }
      this.pages = [];
      this.activeIndex = 0;
      this.undoStack = [];
      this.redoStack = [];
    },

    toggleThumbsDrawer() {
      this.isThumbsOpen = !this.isThumbsOpen;
      const strip = document.getElementById("ps-scan-thumbs");
      const chev = document.getElementById("ps-page-pill-chevron");
      if (strip) strip.style.display = this.isThumbsOpen ? "flex" : "none";
      if (chev) chev.className = this.isThumbsOpen ? "ri-arrow-up-s-line" : "ri-arrow-down-s-line";
      if (this.isThumbsOpen) this.renderThumbnails();
    },

    async switchToCamera() {
      this.viewMode = "camera";
      this.stableFrames = 0;
      this.awaitingSceneChangeAfterCapture = false;
      this._updateShutterArcProgress(0);
      document.getElementById("ps-camera-stage").style.display = "flex";
      document.getElementById("ps-review-stage").style.display = "none";
      await this._startCameraStream();
    },

    openReviewWorkspace() {
      if (!this.pages.length) {
        if (typeof window.showToast === "function") {
          window.showToast("Capture or select at least 1 page first.", "info");
        }
        return;
      }
      this._stopCameraStream();
      this.viewMode = "review";
      this.isThumbsOpen = false;
      if (this.activeIndex >= this.pages.length) this.activeIndex = this.pages.length - 1;
      if (this.activeIndex < 0) this.activeIndex = 0;

      document.getElementById("ps-camera-stage").style.display = "none";
      document.getElementById("ps-review-stage").style.display = "flex";
      const strip = document.getElementById("ps-scan-thumbs");
      if (strip) strip.style.display = "none";

      this.closeToolSubpanel();
      this._updateUndoRedoButtons();
      this.renderThumbnails();
      this.renderActiveCanvas();
    },

    openToolSubpanel(toolName) {
      this.toolSnapshot = this._captureFullSnapshot();
      this.activeTool = toolName;
      this.isEyedropperActive = false;

      const dock = document.getElementById("ps-rev-tools-dock");
      const subpanel = document.getElementById("ps-tool-subpanel");
      if (dock) dock.style.display = "none";
      if (subpanel) subpanel.style.display = "block";

      const titleMap = {
        crop: "Crop & Perspective",
        filters: "Filters",
        adjust: "Brightness & Contrast",
        markup: "Markup",
        text: "Edit Text",
        cleanup: "Cleanup",
        resize: "Resize",
        reorder: "Reorder Pages"
      };
      const titleEl = document.getElementById("ps-subpanel-title");
      if (titleEl) titleEl.textContent = titleMap[toolName] || "Edit";

      const page = this.pages[this.activeIndex];
      if (page) {
        if (toolName === "crop" && page.isCropped) {
          page.workingCanvas = this._cloneCanvas(page.rawCanvas);
          page.isCropped = false;
          this._processPagePipeline(page);
        } else if (toolName !== "crop" && !page.isCropped) {
          this.applyPerspectiveCrop();
        }
      }

      this._syncSubpanelUI(toolName);
      this.renderActiveCanvas();
    },

    _syncSubpanelUI(toolName) {
      const panels = ["crop", "filters", "adjust", "markup", "text", "cleanup", "resize", "reorder"];
      panels.forEach((p) => {
        const el = document.getElementById(`ps-sub-${p}`);
        if (el) el.style.display = p === toolName ? "flex" : "none";
      });

      if (toolName === "filters") this._renderFilterCardsUI();
      if (toolName === "adjust") this.selectAdjustMetric(this.adjustMetric);
      if (toolName === "resize") {
        document.querySelectorAll(".ps-resize-card").forEach((b) => {
          b.classList.toggle("active", b.getAttribute("data-size") === this.pageSizePreset);
        });
      }
      if (toolName === "reorder") {
        const lbl = document.getElementById("ps-reorder-label");
        if (lbl) lbl.textContent = `Page ${this.activeIndex + 1} of ${this.pages.length}`;
      }
    },

    cancelActiveTool() {
      this.isEyedropperActive = false;
      if (this.toolSnapshot) {
        this._restoreFullSnapshot(this.toolSnapshot);
        this.toolSnapshot = null;
      }
      this.closeToolSubpanel();
    },

    confirmActiveTool() {
      this.isEyedropperActive = false;
      if (this.activeTool === "crop") {
        this.applyPerspectiveCrop();
      }
      if (this.toolSnapshot) {
        this.undoStack.push(this.toolSnapshot);
        if (this.undoStack.length > 15) this.undoStack.shift();
        this.redoStack = [];
        this.toolSnapshot = null;
        this._updateUndoRedoButtons();
      }
      this.closeToolSubpanel();
    },

    closeToolSubpanel() {
      this.activeTool = null;
      this.isEyedropperActive = false;
      const dock = document.getElementById("ps-rev-tools-dock");
      const subpanel = document.getElementById("ps-tool-subpanel");
      if (subpanel) subpanel.style.display = "none";
      if (dock) dock.style.display = "flex";
      this.renderActiveCanvas();
      if (this.isThumbsOpen) this.renderThumbnails();
    },

    setCleanupMode(mode) {
      this.cleanupMode = mode;
      this.isEyedropperActive = false;
      document.getElementById("ps-cleanup-eyedropper-btn")?.classList.remove("active");
    },

    setCleanupSelectedColor(hex) {
      this.cleanupSelectedColor = hex;
      this.cleanupMode = "selected";
      const radio = document.querySelector('input[name="ps-cleanup-mode"][value="selected"]');
      if (radio) radio.checked = true;
    },

    setCleanupSize(val) {
      this.cleanupBrushSize = parseInt(val, 10) || 28;
      const lbl = document.getElementById("ps-cleanup-size-val");
      if (lbl) lbl.textContent = String(this.cleanupBrushSize);
    },

    activateEyedropper() {
      this.isEyedropperActive = !this.isEyedropperActive;
      document.getElementById("ps-cleanup-eyedropper-btn")?.classList.toggle("active", this.isEyedropperActive);
      if (this.isEyedropperActive && typeof window.showToast === "function") {
        window.showToast("Tap anywhere on the document to pick replacement color.", "info");
      }
    },

    setPreset(presetName) {
      this.scanPreset = presetName;
      this.stableFrames = 0;
      this.awaitingSceneChangeAfterCapture = false;
      this._updateShutterArcProgress(0);
      document.querySelectorAll(".ps-mode-tab").forEach((btn) => {
        btn.classList.toggle("active", btn.getAttribute("data-mode") === presetName);
      });
      const bookGuide = document.getElementById("ps-book-split-guide");
      if (bookGuide) bookGuide.style.display = presetName === "Book" ? "flex" : "none";
    },

    toggleBookOrder() {
      this.bookOrderReversed = !this.bookOrderReversed;
      const pill = document.getElementById("ps-book-order-pill");
      if (pill) pill.textContent = this.bookOrderReversed ? "2 ⇄ 1" : "1 ⇄ 2";
    },

    toggleAutoCapture() {
      this.autoCaptureEnabled = !this.autoCaptureEnabled;
      this.stableFrames = 0;
      this._updateShutterArcProgress(0);
      document.getElementById("ps-auto-cap-btn")?.classList.toggle("active", this.autoCaptureEnabled);
      const pill = document.getElementById("ps-steady-pill");
      if (pill && !this.autoCaptureEnabled) pill.style.display = "none";
    },

    async toggleTorch() {
      if (!this.mediaStream) return;
      const track = this.mediaStream.getVideoTracks()[0];
      if (!track) return;
      try {
        const caps = track.getCapabilities ? track.getCapabilities() : {};
        if (!caps.torch) {
          if (typeof window.showToast === "function") window.showToast("Flash not supported on this device.", "info");
          return;
        }
        this.torchEnabled = !this.torchEnabled;
        await track.applyConstraints({ advanced: [{ torch: this.torchEnabled }] });
        document.getElementById("ps-torch-btn")?.classList.toggle("active", this.torchEnabled);
      } catch (e) {}
    },

    // Point 4: Tap-to-Focus handler on Camera Viewport
    async triggerCameraTapFocus(clientX, clientY) {
      const viewport = document.getElementById("ps-video-viewport");
      const reticle = document.getElementById("ps-focus-reticle");
      if (!viewport || !reticle) return;

      const rect = viewport.getBoundingClientRect();
      const relX = clientX - rect.left;
      const relY = clientY - rect.top;
      const normX = Math.min(1, Math.max(0, relX / rect.width));
      const normY = Math.min(1, Math.max(0, relY / rect.height));

      // Show animated focus circle at tapped point
      reticle.style.left = `${relX}px`;
      reticle.style.top = `${relY}px`;
      reticle.style.display = "flex";
      reticle.classList.remove("pulse");
      void reticle.offsetWidth;
      reticle.classList.add("pulse");

      // Pause auto-capture briefly so camera lens settles on the newly tapped focus plane
      this.stableFrames = 0;
      this._updateShutterArcProgress(0);

      if (this.mediaStream) {
        const track = this.mediaStream.getVideoTracks()[0];
        if (track && track.getCapabilities && track.applyConstraints) {
          try {
            const caps = track.getCapabilities();
            const adv = [];
            if (Array.isArray(caps.focusMode) && caps.focusMode.includes("continuous")) {
              adv.push({ focusMode: "continuous" });
            } else if (Array.isArray(caps.focusMode) && caps.focusMode.includes("single-shot")) {
              adv.push({ focusMode: "single-shot" });
            }
            if (caps.pointsOfInterest) {
              adv.push({ pointsOfInterest: [{ x: normX, y: normY }] });
            }
            if (adv.length > 0) {
              await track.applyConstraints({ advanced: adv });
            }
          } catch (e) {}
        }
      }

      clearTimeout(this._focusHideTimer);
      this._focusHideTimer = setTimeout(() => {
        if (reticle) reticle.style.display = "none";
      }, 1300);
    },

    async _startCameraStream() {
      const video = document.getElementById("ps-live-video");
      const fallback = document.getElementById("ps-camera-fallback");
      const errMsg = document.getElementById("ps-cam-err-msg");
      if (!video) return;

      this._stopCameraStream();
      if (fallback) fallback.style.display = "none";

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        if (errMsg) errMsg.textContent = "Live camera requires HTTPS or localhost. Use 'Open Camera' below.";
        if (fallback) fallback.style.display = "flex";
        return;
      }

      try {
        // Point 3: Request Full HD (1920x1080) + continuous autofocus
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920, min: 1280 },
            height: { ideal: 1080, min: 720 },
            focusMode: { ideal: "continuous" }
          },
          audio: false
        });
        video.srcObject = this.mediaStream;
        video.setAttribute("playsinline", "true");
        video.muted = true;
        await video.play();

        // Bind hardware ImageCapture for full native sensor HD photos
        const track = this.mediaStream.getVideoTracks()[0];
        if (track && typeof window.ImageCapture === "function") {
          try {
            this.imageCaptureObj = new window.ImageCapture(track);
          } catch (e) {
            this.imageCaptureObj = null;
          }
        }

        this._startLiveEdgeOverlayLoop();
      } catch (err) {
        try {
          this.mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          video.srcObject = this.mediaStream;
          await video.play();
          this._startLiveEdgeOverlayLoop();
        } catch (err2) {
          if (errMsg) errMsg.textContent = "Camera permission blocked. Tap 'Open Camera' or pick from Gallery.";
          if (fallback) fallback.style.display = "flex";
        }
      }
    },

    _stopCameraStream() {
      if (this.detectRafId) {
        cancelAnimationFrame(this.detectRafId);
        this.detectRafId = null;
      }
      this.imageCaptureObj = null;
      if (this.mediaStream) {
        this.mediaStream.getTracks().forEach((t) => t.stop());
        this.mediaStream = null;
      }
      const video = document.getElementById("ps-live-video");
      if (video) video.srcObject = null;
      const pill = document.getElementById("ps-steady-pill");
      if (pill) pill.style.display = "none";
    },

    _updateShutterArcProgress(fraction) {
      const arc = document.getElementById("ps-shutter-arc");
      if (!arc) return;
      const clamped = Math.min(1, Math.max(0, fraction));
      const circumference = 201;
      arc.style.strokeDashoffset = String(Math.round(circumference * (1 - clamped)));
    },

    // Laplacian variance sharpness check so auto-capture waits until lens is in sharp focus
    _computeImageSharpness(ctx, w, h) {
      const data = ctx.getImageData(0, 0, w, h).data;
      let sum = 0;
      let count = 0;
      for (let y = 2; y < h - 2; y += 3) {
        for (let x = 2; x < w - 2; x += 3) {
          const i = (y * w + x) * 4;
          const lC = data[i + 1];
          const lL = data[i - 3];
          const lR = data[i + 5];
          const lU = data[i - w * 4 + 1];
          const lD = data[i + w * 4 + 1];
          const lap = Math.abs(4 * lC - lL - lR - lU - lD);
          sum += lap;
          count++;
        }
      }
      return sum / (count || 1);
    },

    _startLiveEdgeOverlayLoop() {
      const video = document.getElementById("ps-live-video");
      const overlay = document.getElementById("ps-live-overlay");
      const steadyPill = document.getElementById("ps-steady-pill");
      if (!video || !overlay) return;

      const sampleCanvas = document.createElement("canvas");
      const sCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
      let frameTick = 0;
      const REQUIRED_STABLE_TICKS = 16; // ~2.6 seconds steady focus lock before auto-capture

      const tick = () => {
        if (this.viewMode !== "camera" || !this.mediaStream) return;

        if (video.readyState >= 2 && video.videoWidth > 0) {
          overlay.width = video.videoWidth;
          overlay.height = video.videoHeight;
          const oCtx = overlay.getContext("2d");
          oCtx.clearRect(0, 0, overlay.width, overlay.height);

          frameTick++;
          if (frameTick % 5 === 0) {
            sampleCanvas.width = 220;
            sampleCanvas.height = Math.max(120, Math.round((video.videoHeight / video.videoWidth) * 220));
            sCtx.drawImage(video, 0, 0, sampleCanvas.width, sampleCanvas.height);

            const detected = this._autoDetectDocumentCorners(sampleCanvas, true);
            const sharpness = this._computeImageSharpness(sCtx, sampleCanvas.width, sampleCanvas.height);

            if (detected) {
              const scaleX = overlay.width / sampleCanvas.width;
              const scaleY = overlay.height / sampleCanvas.height;
              const scaledQuad = detected.map((p) => ({
                x: Math.round(p.x * scaleX),
                y: Math.round(p.y * scaleY)
              }));

              const quadSig = `${Math.round(scaledQuad[0].x / 20)},${Math.round(scaledQuad[0].y / 20)},${Math.round(scaledQuad[2].x / 20)},${Math.round(scaledQuad[2].y / 20)}`;

              // Unlock auto-capture only after user moves camera / swaps to next page
              if (this.awaitingSceneChangeAfterCapture) {
                if (this.lastCapturedQuadSignature && quadSig !== this.lastCapturedQuadSignature) {
                  this.awaitingSceneChangeAfterCapture = false;
                }
              }

              if (this.lastLiveQuad && !this.awaitingSceneChangeAfterCapture) {
                const drift =
                  Math.hypot(scaledQuad[0].x - this.lastLiveQuad[0].x, scaledQuad[0].y - this.lastLiveQuad[0].y) +
                  Math.hypot(scaledQuad[2].x - this.lastLiveQuad[2].x, scaledQuad[2].y - this.lastLiveQuad[2].y);

                // Require both physical steadiness AND sharp lens focus (sharpness >= 7.5)
                if (drift < overlay.width * 0.032 && sharpness >= 7.5) {
                  this.stableFrames++;
                } else {
                  this.stableFrames = Math.max(0, this.stableFrames - 2);
                }
              } else {
                this.stableFrames = 0;
              }
              this.lastLiveQuad = scaledQuad;
              this._currentQuadSig = quadSig;
            } else {
              this.lastLiveQuad = null;
              this.stableFrames = 0;
              this.awaitingSceneChangeAfterCapture = false;
            }
          }

          if (this.lastLiveQuad) {
            const q = this.lastLiveQuad;
            oCtx.save();
            oCtx.strokeStyle = "#38bdf8";
            oCtx.lineWidth = Math.max(4, Math.round(overlay.width / 220));
            oCtx.fillStyle = "rgba(56, 189, 248, 0.14)";
            oCtx.beginPath();
            oCtx.moveTo(q[0].x, q[0].y);
            oCtx.lineTo(q[1].x, q[1].y);
            oCtx.lineTo(q[2].x, q[2].y);
            oCtx.lineTo(q[3].x, q[3].y);
            oCtx.closePath();
            oCtx.fill();
            oCtx.stroke();

            const dotR = Math.max(14, Math.round(overlay.width / 48));
            q.forEach((pt) => {
              oCtx.beginPath();
              oCtx.arc(pt.x, pt.y, dotR, 0, Math.PI * 2);
              oCtx.fillStyle = "#2563eb";
              oCtx.fill();
              oCtx.lineWidth = 3;
              oCtx.strokeStyle = "#ffffff";
              oCtx.stroke();
            });
            oCtx.restore();

            if (this.autoCaptureEnabled && !this.awaitingSceneChangeAfterCapture && this.stableFrames >= 4 && !this.isCapturingFrame) {
              const progress = (this.stableFrames - 4) / (REQUIRED_STABLE_TICKS - 4);
              this._updateShutterArcProgress(progress);
              if (steadyPill) {
                steadyPill.textContent = "Focusing... hold steady";
                steadyPill.style.display = "block";
              }
              if (this.stableFrames >= REQUIRED_STABLE_TICKS) {
                this.stableFrames = 0;
                this._updateShutterArcProgress(0);
                this.awaitingSceneChangeAfterCapture = true;
                this.lastCapturedQuadSignature = this._currentQuadSig;
                this.captureFromVideo(false);
              }
            } else {
              this._updateShutterArcProgress(0);
              if (steadyPill) steadyPill.style.display = "none";
            }
          } else {
            this._updateShutterArcProgress(0);
            if (steadyPill) steadyPill.style.display = "none";
          }
        }

        this.detectRafId = requestAnimationFrame(tick);
      };

      this.detectRafId = requestAnimationFrame(tick);
    },

    // Point 3: Full HD Capture (uses hardware ImageCapture.takePhoto when available, else full HD video frame)
    async captureFromVideo(isManualShutter = false) {
      const video = document.getElementById("ps-live-video");
      if (!video || !video.videoWidth || this.isCapturingFrame) {
        if (!video || !video.videoWidth) {
          document.getElementById("ps-scan-cam-input")?.click();
        }
        return;
      }

      this.isCapturingFrame = true;
      try {
        let sourceBitmapOrImg = null;
        let srcW = video.videoWidth;
        let srcH = video.videoHeight;

        // Try native full-resolution photo via ImageCapture API first
        if (this.imageCaptureObj && typeof this.imageCaptureObj.takePhoto === "function") {
          try {
            const photoBlob = await this.imageCaptureObj.takePhoto();
            const img = await this._loadImageFromFile(photoBlob);
            sourceBitmapOrImg = img;
            srcW = img.naturalWidth;
            srcH = img.naturalHeight;
          } catch (e) {
            sourceBitmapOrImg = null;
          }
        }

        const rawCanvas = document.createElement("canvas");
        const maxDim = 2560; // Full HD+ crisp resolution
        let w = srcW;
        let h = srcH;
        if (Math.max(w, h) > maxDim) {
          const s = maxDim / Math.max(w, h);
          w = Math.round(w * s);
          h = Math.round(h * s);
        }
        rawCanvas.width = w;
        rawCanvas.height = h;
        rawCanvas.getContext("2d").drawImage(sourceBitmapOrImg || video, 0, 0, w, h);

        if (this.scanPreset === "Book") {
          const halfW = Math.round(w / 2);
          const leftC = document.createElement("canvas");
          leftC.width = halfW;
          leftC.height = h;
          leftC.getContext("2d").drawImage(rawCanvas, 0, 0, halfW, h, 0, 0, halfW, h);

          const rightC = document.createElement("canvas");
          rightC.width = w - halfW;
          rightC.height = h;
          rightC.getContext("2d").drawImage(rawCanvas, halfW, 0, w - halfW, h, 0, 0, w - halfW, h);

          if (this.bookOrderReversed) {
            this._addCanvasPage(rightC);
            this._addCanvasPage(leftC);
          } else {
            this._addCanvasPage(leftC);
            this._addCanvasPage(rightC);
          }
        } else {
          this._addCanvasPage(rawCanvas);
        }

        if (isManualShutter) {
          this.awaitingSceneChangeAfterCapture = true;
          this.lastCapturedQuadSignature = this._currentQuadSig;
        }

        // Freeze captured image on viewport & run visible Top->Bottom->Top laser scan animation
        const overlay = document.getElementById("ps-live-overlay");
        if (overlay) {
          overlay.width = rawCanvas.width;
          overlay.height = rawCanvas.height;
          overlay.getContext("2d").drawImage(rawCanvas, 0, 0);
        }

        const laserEl = document.getElementById("ps-scan-laser-beam");
        if (laserEl) {
          laserEl.classList.remove("scanning");
          void laserEl.offsetWidth;
          laserEl.classList.add("scanning");
          setTimeout(() => laserEl.classList.remove("scanning"), 1180);
        }

        const flashEl = document.getElementById("ps-capture-flash");
        if (flashEl) {
          flashEl.classList.add("flash");
          setTimeout(() => flashEl.classList.remove("flash"), 180);
        }

        if (typeof window.showToast === "function") {
          window.showToast(`📸 HD Page ${this.pages.length} scanned & auto-cropped!`, "success");
        }
      } finally {
        setTimeout(() => {
          this.isCapturingFrame = false;
        }, 1350);
      }
    },

    _warpPerspectiveFromCorners(srcCanvas, corners) {
      const [tl, tr, br, bl] = corners;
      const topW = Math.hypot(tr.x - tl.x, tr.y - tl.y);
      const botW = Math.hypot(br.x - bl.x, br.y - bl.y);
      const leftH = Math.hypot(bl.x - tl.x, bl.y - tl.y);
      const rightH = Math.hypot(br.x - tr.x, br.y - tr.y);

      const outW = Math.max(200, Math.round(Math.max(topW, botW)));
      const outH = Math.max(200, Math.round(Math.max(leftH, rightH)));

      const srcData = srcCanvas.getContext("2d").getImageData(0, 0, srcCanvas.width, srcCanvas.height);
      const dstCanvas = document.createElement("canvas");
      dstCanvas.width = outW;
      dstCanvas.height = outH;
      const dstCtx = dstCanvas.getContext("2d");
      const dstData = dstCtx.createImageData(outW, outH);

      const sW = srcCanvas.width;
      const sH = srcCanvas.height;
      const sBuf = srcData.data;
      const dBuf = dstData.data;

      for (let y = 0; y < outH; y++) {
        const v = y / (outH - 1 || 1);
        const leftX = tl.x + (bl.x - tl.x) * v;
        const leftY = tl.y + (bl.y - tl.y) * v;
        const rightX = tr.x + (br.x - tr.x) * v;
        const rightY = tr.y + (br.y - tr.y) * v;

        for (let x = 0; x < outW; x++) {
          const u = x / (outW - 1 || 1);
          const sx = Math.min(sW - 1, Math.max(0, Math.round(leftX + (rightX - leftX) * u)));
          const sy = Math.min(sH - 1, Math.max(0, Math.round(leftY + (rightY - leftY) * u)));

          const sIdx = (sy * sW + sx) * 4;
          const dIdx = (y * outW + x) * 4;
          dBuf[dIdx] = sBuf[sIdx];
          dBuf[dIdx + 1] = sBuf[sIdx + 1];
          dBuf[dIdx + 2] = sBuf[sIdx + 2];
          dBuf[dIdx + 3] = 255;
        }
      }

      dstCtx.putImageData(dstData, 0, 0);
      return dstCanvas;
    },

    _addCanvasPage(rawCanvas) {
      const detectedCorners = this._autoDetectDocumentCorners(rawCanvas, false);
      const defaultFilter =
        this.scanPreset === "Whiteboard"
          ? "whiteboard"
          : this.scanPreset === "Document" || this.scanPreset === "Book"
          ? "magic"
          : "original";

      // Immediately crop & straighten according to detected edges upon capture
      const croppedCanvas = this._warpPerspectiveFromCorners(rawCanvas, detectedCorners);

      const pageObj = {
        id: "pg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
        rawCanvas,
        workingCanvas: croppedCanvas,
        cleanupLayer: null,
        markupLayer: null,
        textStamps: [],
        corners: detectedCorners,
        filter: defaultFilter,
        brightness: 0,
        contrast: 0,
        isCropped: true,
        processedCanvas: null,
        processedDataUrl: null
      };

      this._processPagePipeline(pageObj);
      this.pages.push(pageObj);
      this.activeIndex = this.pages.length - 1;
      this.updatePageCounterUI();
    },

    updatePageCounterUI() {
      const badge = document.getElementById("ps-page-badge");
      const thumbImg = document.getElementById("ps-last-thumb-img");
      const emptyIcon = document.getElementById("ps-empty-stack-icon");
      if (badge) badge.textContent = String(this.pages.length);

      if (thumbImg && emptyIcon) {
        if (this.pages.length > 0) {
          thumbImg.src = this.pages[this.pages.length - 1].processedDataUrl;
          thumbImg.style.display = "block";
          emptyIcon.style.display = "none";
        } else {
          thumbImg.style.display = "none";
          emptyIcon.style.display = "block";
        }
      }
    },

    /**
     * Point 1: Bright White Document Region + Connected-Component Boundary Detector
     * Specifically isolates bright/white paper sheets & white cards even when placed inside
     * a dark laptop screen, dark desk, or cluttered background.
     */
    _autoDetectDocumentCorners(canvas, strictMode = false) {
      const w = canvas.width;
      const h = canvas.height;
      const gridW = 200;
      const gridH = Math.max(110, Math.round((h / w) * gridW));

      const tmp = document.createElement("canvas");
      tmp.width = gridW;
      tmp.height = gridH;
      const tctx = tmp.getContext("2d");
      tctx.drawImage(canvas, 0, 0, gridW, gridH);
      const data = tctx.getImageData(0, 0, gridW, gridH).data;

      // Step 1: Compute adaptive luminance histogram to find white paper threshold
      const totalPx = gridW * gridH;
      const lumArr = new Uint8Array(totalPx);
      const satArr = new Uint8Array(totalPx);
      let lumSum = 0;

      for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const maxC = Math.max(r, g, b);
        const minC = Math.min(r, g, b);
        const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        lumArr[p] = lum;
        satArr[p] = maxC - minC;
        lumSum += lum;
      }
      const meanLum = lumSum / totalPx;

      // White paper / bright card mask: high luminance & low color saturation (neutral white/off-white)
      const whiteThresh = Math.max(148, Math.min(215, Math.round(meanLum + 26)));
      const mask = new Uint8Array(totalPx);
      for (let p = 0; p < totalPx; p++) {
        if (lumArr[p] >= whiteThresh && satArr[p] <= 58) {
          mask[p] = 1;
        }
      }

      // Step 2: Connected-component flood fill to find the largest contiguous white document sheet
      const visited = new Uint8Array(totalPx);
      let bestComp = null;
      const queue = new Int32Array(totalPx);

      const marginX = Math.round(gridW * 0.04);
      const marginY = Math.round(gridH * 0.04);

      for (let y = marginY; y < gridH - marginY; y++) {
        for (let x = marginX; x < gridW - marginX; x++) {
          const startIdx = y * gridW + x;
          if (!mask[startIdx] || visited[startIdx]) continue;

          let head = 0, tail = 0;
          queue[tail++] = startIdx;
          visited[startIdx] = 1;

          let area = 0;
          let touchesOuterFrame = 0;
          let tl = { x, y, score: x + y };
          let tr = { x, y, score: x - y };
          let br = { x, y, score: x + y };
          let bl = { x, y, score: x - y };

          while (head < tail) {
            const cur = queue[head++];
            const cy = (cur / gridW) | 0;
            const cx = cur - cy * gridW;
            area++;

            if (cx <= 2 || cx >= gridW - 3 || cy <= 2 || cy >= gridH - 3) {
              touchesOuterFrame++;
            }

            const sum = cx + cy;
            const diff = cx - cy;
            if (sum < tl.score) tl = { x: cx, y: cy, score: sum };
            if (diff > tr.score) tr = { x: cx, y: cy, score: diff };
            if (sum > br.score) br = { x: cx, y: cy, score: sum };
            if (diff < bl.score) bl = { x: cx, y: cy, score: diff };

            // 4-connected neighbors
            const n1 = cur - 1;
            const n2 = cur + 1;
            const n3 = cur - gridW;
            const n4 = cur + gridW;
            if (cx > 0 && mask[n1] && !visited[n1]) { visited[n1] = 1; queue[tail++] = n1; }
            if (cx < gridW - 1 && mask[n2] && !visited[n2]) { visited[n2] = 1; queue[tail++] = n2; }
            if (cy > 0 && mask[n3] && !visited[n3]) { visited[n3] = 1; queue[tail++] = n3; }
            if (cy < gridH - 1 && mask[n4] && !visited[n4]) { visited[n4] = 1; queue[tail++] = n4; }
          }

          const areaRatio = area / totalPx;
          // Ignore tiny highlights (<3.5% of frame) and full-screen glare (>85%)
          if (areaRatio >= 0.035 && areaRatio <= 0.85 && touchesOuterFrame < 12) {
            // Prefer central, larger white document components
            const centerX = (tl.x + br.x) / 2;
            const centerY = (tl.y + br.y) / 2;
            const distFromCenter = Math.hypot(centerX - gridW / 2, centerY - gridH / 2) / gridW;
            const rankScore = area * (1.2 - distFromCenter);

            if (!bestComp || rankScore > bestComp.rankScore) {
              bestComp = { tl, tr, br, bl, rankScore };
            }
          }
        }
      }

      if (bestComp) {
        const scaleX = w / gridW;
        const scaleY = h / gridH;
        return [
          { x: Math.round(bestComp.tl.x * scaleX), y: Math.round(bestComp.tl.y * scaleY) },
          { x: Math.round(bestComp.tr.x * scaleX), y: Math.round(bestComp.tr.y * scaleY) },
          { x: Math.round(bestComp.br.x * scaleX), y: Math.round(bestComp.br.y * scaleY) },
          { x: Math.round(bestComp.bl.x * scaleX), y: Math.round(bestComp.bl.y * scaleY) }
        ];
      }

      if (strictMode) return null;

      // Clean preset-proportioned fallback frame when no distinct white paper boundary exists
      if (this.scanPreset === "ID card" || this.scanPreset === "Business") {
        return [
          { x: Math.round(w * 0.14), y: Math.round(h * 0.28) },
          { x: Math.round(w * 0.86), y: Math.round(h * 0.28) },
          { x: Math.round(w * 0.86), y: Math.round(h * 0.72) },
          { x: Math.round(w * 0.14), y: Math.round(h * 0.72) }
        ];
      }
      return [
        { x: Math.round(w * 0.08), y: Math.round(h * 0.08) },
        { x: Math.round(w * 0.92), y: Math.round(h * 0.08) },
        { x: Math.round(w * 0.92), y: Math.round(h * 0.92) },
        { x: Math.round(w * 0.08), y: Math.round(h * 0.92) }
      ];
    },

    reRunAutoDetect() {
      const page = this.pages[this.activeIndex];
      if (!page) return;
      page.workingCanvas = this._cloneCanvas(page.rawCanvas);
      page.isCropped = false;
      page.corners = this._autoDetectDocumentCorners(page.rawCanvas, false);
      this._processPagePipeline(page);
      this.renderActiveCanvas();
    },

    setNoCrop() {
      const page = this.pages[this.activeIndex];
      if (!page) return;
      const w = page.rawCanvas.width;
      const h = page.rawCanvas.height;
      page.workingCanvas = this._cloneCanvas(page.rawCanvas);
      page.isCropped = false;
      page.corners = [
        { x: 0, y: 0 },
        { x: w, y: 0 },
        { x: w, y: h },
        { x: 0, y: h }
      ];
      this._processPagePipeline(page);
      this.renderActiveCanvas();
    },

    async handleFiles(fileList) {
      if (!fileList || !fileList.length) return;
      for (const file of fileList) {
        if (!file.type.startsWith("image/")) continue;
        const img = await this._loadImageFromFile(file);
        const rawCanvas = document.createElement("canvas");
        const maxDim = 2560;
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        if (Math.max(w, h) > maxDim) {
          const scale = maxDim / Math.max(w, h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
        rawCanvas.width = w;
        rawCanvas.height = h;
        rawCanvas.getContext("2d").drawImage(img, 0, 0, w, h);
        this._addCanvasPage(rawCanvas);
      }
      if (this.pages.length > 0 && this.viewMode === "review") {
        this.renderThumbnails();
        this.renderActiveCanvas();
      }
    },

    _loadImageFromFile(file) {
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);
          resolve(img);
        };
        img.onerror = reject;
        img.src = url;
      });
    },

    _renderFilterCardsUI() {
      const grid = document.getElementById("ps-filter-cards-grid");
      const page = this.pages[this.activeIndex];
      if (!grid || !page) return;

      const base = page.workingCanvas;
      const pw = 110;
      const ph = Math.max(82, Math.round((base.height / base.width) * pw));
      const sample = document.createElement("canvas");
      sample.width = pw;
      sample.height = ph;
      sample.getContext("2d").drawImage(base, 0, 0, pw, ph);

      grid.innerHTML = "";
      FILTER_CATALOG.forEach((p) => {
        const prevCanvas = document.createElement("canvas");
        prevCanvas.width = pw;
        prevCanvas.height = ph;
        const pctx = prevCanvas.getContext("2d");
        pctx.drawImage(sample, 0, 0);
        this._applyFilterPixels(pctx, pw, ph, p.id, 0, 0);
        const thumbUrl = prevCanvas.toDataURL("image/jpeg", 0.78);

        const card = document.createElement("div");
        card.className = `ps-filter-visual-card ${page.filter === p.id ? "active" : ""}`;
        card.innerHTML = `
          <div class="ps-fvc-thumb"><img src="${thumbUrl}" alt="${p.label}" /></div>
          <div class="ps-fvc-label">${p.label}</div>
        `;
        card.onclick = () => this.setFilter(p.id);
        grid.appendChild(card);
      });
    },

    setFilter(filterName) {
      const targets = this.applyToAllPages ? this.pages : [this.pages[this.activeIndex]];
      targets.forEach((pg) => {
        if (!pg) return;
        pg.filter = filterName;
        this._processPagePipeline(pg);
      });

      this._renderFilterCardsUI();
      this.renderActiveCanvas();
      if (this.isThumbsOpen) this.renderThumbnails();
      this.updatePageCounterUI();
    },

    selectAdjustMetric(metric) {
      this.adjustMetric = metric;
      document.getElementById("ps-adj-tab-brightness")?.classList.toggle("active", metric === "brightness");
      document.getElementById("ps-adj-tab-contrast")?.classList.toggle("active", metric === "contrast");

      const page = this.pages[this.activeIndex];
      const val = page ? page[metric] || 0 : 0;
      document.getElementById("ps-adj-metric-label").textContent = metric === "brightness" ? "Brightness" : "Contrast";
      document.getElementById("ps-adj-metric-val").textContent = String(val);
      const slider = document.getElementById("ps-adj-slider");
      if (slider) slider.value = String(val);
    },

    onAdjustSliderChange(rawVal) {
      const val = parseInt(rawVal, 10) || 0;
      document.getElementById("ps-adj-metric-val").textContent = String(val);

      const targets = this.applyToAllPages ? this.pages : [this.pages[this.activeIndex]];
      targets.forEach((pg) => {
        if (!pg) return;
        pg[this.adjustMetric] = val;
        this._processPagePipeline(pg);
      });
      this.renderActiveCanvas();
      if (this.isThumbsOpen) this.renderThumbnails();
    },

    toggleApplyToAll(checked) {
      this.applyToAllPages = Boolean(checked);
      document.querySelectorAll(".ps-toggle-chk").forEach((c) => (c.checked = this.applyToAllPages));
      if (this.applyToAllPages && this.pages[this.activeIndex]) {
        const src = this.pages[this.activeIndex];
        this.pages.forEach((pg) => {
          pg.filter = src.filter;
          pg.brightness = src.brightness;
          pg.contrast = src.contrast;
          this._processPagePipeline(pg);
        });
        if (this.isThumbsOpen) this.renderThumbnails();
      }
    },

    setMarkupColor(hex, btnEl) {
      this.markupColor = hex;
      document.querySelectorAll(".ps-color-dot").forEach((b) => b.classList.remove("active"));
      if (btnEl) btnEl.classList.add("active");
    },

    clearMarkupLayer() {
      const page = this.pages[this.activeIndex];
      if (!page) return;
      page.markupLayer = null;
      this._processPagePipeline(page);
      this.renderActiveCanvas();
    },

    addTextAnnotation() {
      const page = this.pages[this.activeIndex];
      const input = document.getElementById("ps-text-stamp-input");
      const text = (input?.value || "").trim();
      if (!page || !text) return;

      page.textStamps.push({
        text,
        x: Math.round(page.workingCanvas.width * 0.14),
        y: Math.round(page.workingCanvas.height * (0.2 + page.textStamps.length * 0.08))
      });
      if (input) input.value = "";
      this._processPagePipeline(page);
      this.renderActiveCanvas();
    },

    clearTextAnnotations() {
      const page = this.pages[this.activeIndex];
      if (!page) return;
      page.textStamps = [];
      this._processPagePipeline(page);
      this.renderActiveCanvas();
    },

    setPageSize(sizeKey, btnEl) {
      this.pageSizePreset = sizeKey;
      document.querySelectorAll(".ps-resize-card").forEach((b) => b.classList.remove("active"));
      if (btnEl) btnEl.classList.add("active");
    },

    moveActivePage(delta) {
      const newIdx = this.activeIndex + delta;
      if (newIdx < 0 || newIdx >= this.pages.length) return;
      const [moved] = this.pages.splice(this.activeIndex, 1);
      this.pages.splice(newIdx, 0, moved);
      this.activeIndex = newIdx;
      const lbl = document.getElementById("ps-reorder-label");
      if (lbl) lbl.textContent = `Page ${this.activeIndex + 1} of ${this.pages.length}`;
      this.renderThumbnails();
      this.renderActiveCanvas();
    },

    resetCleanup() {
      const page = this.pages[this.activeIndex];
      if (!page) return;
      page.cleanupLayer = null;
      this._processPagePipeline(page);
      this.renderActiveCanvas();
    },

    retakeActivePage() {
      if (this.activeIndex >= 0 && this.pages.length > 0) {
        this._pushUndoState();
        this.pages.splice(this.activeIndex, 1);
        this.activeIndex = Math.max(0, this.pages.length - 1);
        this.updatePageCounterUI();
      }
      this.switchToCamera();
    },

    prevPage() {
      if (this.activeIndex > 0) {
        this.activeIndex--;
        this.renderThumbnails();
        this.renderActiveCanvas();
        if (this.activeTool) this._syncSubpanelUI(this.activeTool);
      }
    },

    nextPage() {
      if (this.activeIndex < this.pages.length - 1) {
        this.activeIndex++;
        this.renderThumbnails();
        this.renderActiveCanvas();
        if (this.activeTool) this._syncSubpanelUI(this.activeTool);
      }
    },

    applyPerspectiveCrop() {
      const page = this.pages[this.activeIndex];
      if (!page || page.isCropped) return;

      page.workingCanvas = this._warpPerspectiveFromCorners(page.rawCanvas, page.corners);
      page.isCropped = true;

      this._processPagePipeline(page);
      this.renderActiveCanvas();
      if (this.isThumbsOpen) this.renderThumbnails();
      this.updatePageCounterUI();
    },

    _applyFilterPixels(ctx, width, height, filterName, bright, contrast) {
      const imgData = ctx.getImageData(0, 0, width, height);
      const d = imgData.data;
      const cFactor = (259 * (contrast + 255)) / (255 * (259 - contrast));

      for (let i = 0; i < d.length; i += 4) {
        let r = d[i], g = d[i + 1], b = d[i + 2];

        if (filterName === "magic") {
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          if (lum > 160) {
            const lift = Math.min(255, lum + (255 - lum) * 0.82);
            const ratio = lift / (lum || 1);
            r = Math.min(255, r * ratio);
            g = Math.min(255, g * ratio);
            b = Math.min(255, b * ratio);
          } else {
            r = Math.max(0, (r - 128) * 1.3 + 112);
            g = Math.max(0, (g - 128) * 1.3 + 112);
            b = Math.max(0, (b - 128) * 1.3 + 112);
          }
        } else if (filterName === "vintage") {
          const tr = 0.393 * r + 0.769 * g + 0.189 * b;
          const tg = 0.349 * r + 0.686 * g + 0.168 * b;
          const tb = 0.272 * r + 0.534 * g + 0.131 * b;
          r = Math.min(255, tr * 1.04);
          g = Math.min(255, tg * 0.99);
          b = Math.min(255, tb * 0.88);
        } else if (filterName === "light_text") {
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          const boosted = lum < 210 ? Math.max(0, (lum - 140) * 1.65 + 115) : 255;
          const scale = boosted / (lum || 1);
          r = Math.min(255, Math.max(0, r * scale));
          g = Math.min(255, Math.max(0, g * scale));
          b = Math.min(255, Math.max(0, b * scale));
        } else if (filterName === "crumpled") {
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          if (lum > 125) {
            r = g = b = Math.min(255, lum + (255 - lum) * 0.9);
          } else {
            r = Math.max(0, r * 0.75);
            g = Math.max(0, g * 0.75);
            b = Math.max(0, b * 0.75);
          }
        } else if (filterName === "warm") {
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          if (lum > 155) {
            r = 255;
            g = 243;
            b = 220;
          } else {
            r = Math.min(255, r * 1.08);
            g = Math.min(255, g * 1.01);
            b = Math.max(0, b * 0.88);
          }
        } else if (filterName === "cool") {
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          if (lum > 155) {
            r = 232;
            g = 242;
            b = 255;
          } else {
            r = Math.max(0, r * 0.9);
            g = Math.min(255, g * 1.02);
            b = Math.min(255, b * 1.12);
          }
        } else if (filterName === "grayscale") {
          const gray = 0.299 * r + 0.587 * g + 0.114 * b;
          const boosted = Math.min(255, Math.max(0, (gray - 128) * 1.24 + 138));
          r = g = b = boosted;
        } else if (filterName === "whiteboard") {
          const gray = 0.299 * r + 0.587 * g + 0.114 * b;
          if (gray > 142) {
            r = g = b = 255;
          } else {
            r = Math.min(255, r * 1.15);
            g = Math.min(255, g * 1.15);
            b = Math.min(255, b * 1.15);
          }
        }

        if (bright !== 0 || contrast !== 0) {
          r = Math.min(255, Math.max(0, cFactor * (r - 128) + 128 + bright));
          g = Math.min(255, Math.max(0, cFactor * (g - 128) + 128 + bright));
          b = Math.min(255, Math.max(0, cFactor * (b - 128) + 128 + bright));
        }

        d[i] = r;
        d[i + 1] = g;
        d[i + 2] = b;
      }
      ctx.putImageData(imgData, 0, 0);
    },

    _processPagePipeline(page) {
      const src = page.workingCanvas;
      const out = document.createElement("canvas");
      out.width = src.width;
      out.height = src.height;
      const ctx = out.getContext("2d");
      ctx.drawImage(src, 0, 0);

      this._applyFilterPixels(ctx, out.width, out.height, page.filter, page.brightness || 0, page.contrast || 0);

      if (page.cleanupLayer) ctx.drawImage(page.cleanupLayer, 0, 0, out.width, out.height);
      if (page.markupLayer) ctx.drawImage(page.markupLayer, 0, 0, out.width, out.height);

      if (page.textStamps && page.textStamps.length) {
        ctx.save();
        ctx.font = `bold ${Math.max(24, Math.round(out.width / 28))}px sans-serif`;
        ctx.fillStyle = "#0f172a";
        page.textStamps.forEach((st) => ctx.fillText(st.text, st.x, st.y));
        ctx.restore();
      }

      page.processedCanvas = out;
      page.processedDataUrl = out.toDataURL("image/jpeg", 0.92);
    },

    rotateActive(deg) {
      const page = this.pages[this.activeIndex];
      if (!page) return;
      this._pushUndoState();

      const rotateCanvas = (c) => {
        const rot = document.createElement("canvas");
        rot.width = c.height;
        rot.height = c.width;
        const rctx = rot.getContext("2d");
        rctx.translate(rot.width / 2, rot.height / 2);
        rctx.rotate((deg * Math.PI) / 180);
        rctx.drawImage(c, -c.width / 2, -c.height / 2);
        return rot;
      };

      page.rawCanvas = rotateCanvas(page.rawCanvas);
      page.workingCanvas = page.isCropped ? rotateCanvas(page.workingCanvas) : this._cloneCanvas(page.rawCanvas);
      page.corners = this._autoDetectDocumentCorners(page.rawCanvas, false);

      this._processPagePipeline(page);
      this.renderActiveCanvas();
      if (this.isThumbsOpen) this.renderThumbnails();
      this.updatePageCounterUI();
    },

    deleteActivePage() {
      if (this.activeIndex < 0) return;
      this._pushUndoState();
      this.pages.splice(this.activeIndex, 1);
      this.activeIndex = Math.min(this.activeIndex, this.pages.length - 1);
      this.updatePageCounterUI();
      if (this.pages.length === 0) {
        this.switchToCamera();
      } else {
        this.renderThumbnails();
        this.renderActiveCanvas();
      }
    },

    renderThumbnails() {
      const container = document.getElementById("ps-scan-thumbs");
      const indicator = document.getElementById("ps-page-indicator-pill");
      if (indicator) {
        const span = indicator.querySelector("span");
        if (span) span.textContent = `Page ${this.activeIndex + 1} of ${this.pages.length}`;
      }
      if (!container) return;
      container.innerHTML = "";

      this.pages.forEach((pg, idx) => {
        const div = document.createElement("div");
        div.className = `ps-rev-thumb-card ${idx === this.activeIndex ? "active" : ""}`;
        div.innerHTML = `
          <img src="${pg.processedDataUrl}" />
          <span class="ps-rev-thumb-num">${idx + 1}</span>
        `;
        div.onclick = () => {
          this.activeIndex = idx;
          this.renderThumbnails();
          this.renderActiveCanvas();
          if (this.activeTool) this._syncSubpanelUI(this.activeTool);
        };
        container.appendChild(div);
      });
    },

    renderActiveCanvas() {
      const page = this.pages[this.activeIndex];
      const canvas = document.getElementById("ps-scan-canvas");
      const indicator = document.getElementById("ps-page-indicator-pill");
      if (indicator) {
        const span = indicator.querySelector("span");
        if (span) span.textContent = `Page ${this.activeIndex + 1} of ${this.pages.length}`;
      }
      if (!page || !canvas) return;

      const src = page.processedCanvas || page.workingCanvas;
      canvas.width = src.width;
      canvas.height = src.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(src, 0, 0);

      if (this.activeTool === "crop" && !page.isCropped) {
        const c = page.corners;
        ctx.save();

        ctx.fillStyle = "rgba(5, 10, 20, 0.45)";
        ctx.beginPath();
        ctx.rect(0, 0, canvas.width, canvas.height);
        ctx.moveTo(c[0].x, c[0].y);
        ctx.lineTo(c[3].x, c[3].y);
        ctx.lineTo(c[2].x, c[2].y);
        ctx.lineTo(c[1].x, c[1].y);
        ctx.closePath();
        ctx.fill("evenodd");

        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = Math.max(4, Math.round(canvas.width / 220));
        ctx.beginPath();
        ctx.moveTo(c[0].x, c[0].y);
        ctx.lineTo(c[1].x, c[1].y);
        ctx.lineTo(c[2].x, c[2].y);
        ctx.lineTo(c[3].x, c[3].y);
        ctx.closePath();
        ctx.stroke();

        const midPoints = [
          { x: (c[0].x + c[1].x) / 2, y: (c[0].y + c[1].y) / 2, angle: Math.atan2(c[1].y - c[0].y, c[1].x - c[0].x) },
          { x: (c[1].x + c[2].x) / 2, y: (c[1].y + c[2].y) / 2, angle: Math.atan2(c[2].y - c[1].y, c[2].x - c[1].x) },
          { x: (c[2].x + c[3].x) / 2, y: (c[2].y + c[3].y) / 2, angle: Math.atan2(c[3].y - c[2].y, c[3].x - c[2].x) },
          { x: (c[3].x + c[0].x) / 2, y: (c[3].y + c[0].y) / 2, angle: Math.atan2(c[0].y - c[3].y, c[0].x - c[3].x) }
        ];
        const barW = Math.max(46, Math.round(canvas.width / 14));
        const barH = Math.max(14, Math.round(canvas.width / 48));
        midPoints.forEach((mp, mIdx) => {
          ctx.save();
          ctx.translate(mp.x, mp.y);
          ctx.rotate(mp.angle);
          ctx.fillStyle = this.draggingHandleIndex === 4 + mIdx ? "#22c55e" : "#cbd5e1";
          ctx.strokeStyle = "#2563eb";
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.roundRect(-barW / 2, -barH / 2, barW, barH, 4);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        });

        const handleR = Math.max(20, Math.round(canvas.width / 36));
        c.forEach((pt, idx) => {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, handleR, 0, Math.PI * 2);
          ctx.fillStyle = idx === this.draggingHandleIndex ? "#22c55e" : "#2563eb";
          ctx.fill();
          ctx.lineWidth = Math.max(3, Math.round(handleR / 5));
          ctx.strokeStyle = "#ffffff";
          ctx.stroke();
        });

        ctx.restore();
      }
    },

    _finalizeAllPendingCrops() {
      this.pages.forEach((pg, idx) => {
        if (!pg.isCropped) {
          this.activeIndex = idx;
          this.applyPerspectiveCrop();
        }
      });
    },

    async exportAndUploadImages() {
      const folderCtx = this._resolveCurrentFolderContext() || this.targetFolderCtx;
      if (!folderCtx) {
        if (typeof window.showToast === "function") {
          window.showToast("Open a mounted Google Drive / OneDrive / SFTP folder first.", "warning");
        }
        return;
      }

      const btn = document.getElementById("ps-save-images-btn");
      btn.disabled = true;
      btn.innerHTML = `<i class="ri-loader-4-line"></i> Saving...`;

      try {
        this._finalizeAllPendingCrops();
        const baseName = (document.getElementById("ps-scan-filename")?.value || this.docTitle || "Scan")
          .replace(/\.pdf$/i, "")
          .trim();

        const activeNavPath =
          Array.isArray(currentFolderNavigation) && currentFolderNavigation.length
            ? currentFolderNavigation.join("/")
            : folderCtx.name;

        const mkRes = await fetch("/api/create-folder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            folder_name: baseName,
            folder_path: activeNavPath,
            provider: folderCtx.provider || "google",
            cloud_folder_id: folderCtx.cloud_id || (folderCtx.account_id ? "root" : ""),
            account_id: folderCtx.account_id || "",
            storage_id: folderCtx.storage_id || "",
            remote_dir: folderCtx.remote_path || "/"
          })
        });
        const mkData = await mkRes.json();
        if (!mkRes.ok || !mkData.success || !mkData.folder_item) {
          throw new Error(mkData.error || `Could not create folder (${mkRes.status})`);
        }

        const newFolder = mkData.folder_item;
        newFolder.children = [];

        for (let i = 0; i < this.pages.length; i++) {
          const pg = this.pages[i];
          const blob = await new Promise((res) => pg.processedCanvas.toBlob(res, "image/jpeg", 0.94));
          const imgFilename = `${baseName}_Page_${i + 1}.jpg`;

          const fd = new FormData();
          fd.append("file", blob, imgFilename);
          fd.append("folder_path", `${activeNavPath}/${newFolder.name}`);
          if (newFolder.storage_id) {
            fd.append("storage_id", newFolder.storage_id);
            fd.append("remote_dir", newFolder.remote_path);
          }
          if (newFolder.account_id) {
            fd.append("cloud_folder_id", newFolder.cloud_id || "root");
            fd.append("account_id", newFolder.account_id);
            fd.append("provider", newFolder.provider || "google");
          }

          const upRes = await fetch("/api/upload-file", { method: "POST", body: fd });
          const upData = await upRes.json();
          if (upRes.ok && upData.success && upData.file_item) {
            newFolder.children.push(upData.file_item);
          }
        }

        this._insertItemIntoCurrentVaultView(newFolder);

        if (typeof window.showToast === "function") {
          window.showToast(`✅ Saved ${this.pages.length} HD images inside "${newFolder.name}"!`, "success");
        }
        this.close();
      } catch (err) {
        if (typeof window.showToast === "function") {
          window.showToast(err.message, "error");
        }
      } finally {
        btn.disabled = false;
        btn.innerHTML = `<i class="ri-image-2-line"></i> Save Images`;
      }
    },

    async exportAndUploadPdf() {
      const folderCtx = this._resolveCurrentFolderContext() || this.targetFolderCtx;
      if (!folderCtx) {
        if (typeof window.showToast === "function") {
          window.showToast("Open a mounted Google Drive / OneDrive / SFTP folder first.", "warning");
        }
        return;
      }

      const btn = document.getElementById("ps-save-pdf-btn");
      btn.disabled = true;
      btn.innerHTML = `<i class="ri-loader-4-line"></i> Saving...`;

      try {
        this._finalizeAllPendingCrops();
        let filename = (document.getElementById("ps-scan-filename")?.value || this.docTitle || "Scan").trim();
        if (!filename.toLowerCase().endsWith(".pdf")) filename += ".pdf";

        const { jsPDF } = window.jspdf || {};
        if (!jsPDF) throw new Error("jsPDF library not loaded.");

        const sizeSpec = PAGE_SIZE_CATALOG.find((s) => s.id === this.pageSizePreset) || PAGE_SIZE_CATALOG[0];
        const pdf = new jsPDF({
          orientation: sizeSpec.orient === "l" ? "landscape" : "portrait",
          unit: "mm",
          format: [sizeSpec.w, sizeSpec.h],
          compress: true
        });
        const pageW = pdf.internal.pageSize.getWidth();
        const pageH = pdf.internal.pageSize.getHeight();

        this.pages.forEach((pg, i) => {
          if (i > 0) pdf.addPage();
          const imgW = pg.processedCanvas.width;
          const imgH = pg.processedCanvas.height;
          const margin = sizeSpec.id === "card" ? 2 : sizeSpec.id === "auto" ? 4 : 8;
          const ratio = Math.min((pageW - margin) / imgW, (pageH - margin) / imgH);
          const renderW = imgW * ratio;
          const renderH = imgH * ratio;
          pdf.addImage(
            pg.processedDataUrl,
            "JPEG",
            (pageW - renderW) / 2,
            (pageH - renderH) / 2,
            renderW,
            renderH,
            undefined,
            "MEDIUM"
          );
        });

        const pdfBlob = pdf.output("blob");
        const formData = new FormData();
        formData.append("file", pdfBlob, filename);
        formData.append(
          "folder_path",
          Array.isArray(currentFolderNavigation) && currentFolderNavigation.length
            ? currentFolderNavigation.join("/")
            : folderCtx.name
        );

        if (folderCtx.storage_id) {
          formData.append("storage_id", folderCtx.storage_id);
          formData.append("remote_dir", folderCtx.remote_path || "/");
        }
        if (folderCtx.account_id) {
          formData.append("cloud_folder_id", folderCtx.cloud_id || "root");
          formData.append("account_id", folderCtx.account_id);
          formData.append("provider", folderCtx.provider || "google");
        }

        const res = await fetch("/api/upload-file", { method: "POST", body: formData });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || `Upload failed (${res.status})`);
        }

        if (data.file_item) {
          this._insertItemIntoCurrentVaultView(data.file_item);
        }

        if (typeof window.showToast === "function") {
          window.showToast(`✅ "${filename}" saved to ${folderCtx.name}!`, "success");
        }
        this.close();
      } catch (err) {
        if (typeof window.showToast === "function") {
          window.showToast(err.message, "error");
        }
      } finally {
        btn.disabled = false;
        btn.innerHTML = `<i class="ri-file-pdf-2-line"></i> Save PDF`;
      }
    },

    _insertItemIntoCurrentVaultView(newItem) {
      if (!newItem || typeof globalVaultTree === "undefined" || !Array.isArray(currentFolderNavigation)) return;
      let targetArray = globalVaultTree;
      for (const folderName of currentFolderNavigation) {
        const found = targetArray.find((item) => item.type === "folder" && item.name === folderName);
        if (found) {
          if (!found.children) found.children = [];
          targetArray = found.children;
        }
      }
      const existingIdx = targetArray.findIndex((item) => item.name === newItem.name && item.type === newItem.type);
      if (existingIdx !== -1) targetArray[existingIdx] = newItem;
      else targetArray.push(newItem);

      try {
        sessionStorage.setItem("ps_cached_vault_tree", JSON.stringify(globalVaultTree));
      } catch (e) {}

      if (typeof renderCurrentFolderLevel === "function") {
        renderCurrentFolderLevel();
      }
    },

    _bindEvents() {
      const camInput = document.getElementById("ps-scan-cam-input");
      if (camInput) {
        camInput.addEventListener("change", (e) => {
          this.handleFiles(e.target.files);
          e.target.value = "";
        });
      }

      const galInput = document.getElementById("ps-scan-gallery-input");
      if (galInput) {
        galInput.addEventListener("change", (e) => {
          this.handleFiles(e.target.files);
          e.target.value = "";
        });
      }

      // Point 4: Tap-to-Focus on Camera Viewport
      const viewport = document.getElementById("ps-video-viewport");
      if (viewport) {
        viewport.addEventListener("click", (e) => {
          if (this.viewMode !== "camera") return;
          if (e.target.closest("button") || e.target.closest(".ps-book-order-pill")) return;
          this.triggerCameraTapFocus(e.clientX, e.clientY);
        });
      }

      const canvas = document.getElementById("ps-scan-canvas");
      if (!canvas) return;

      const getCanvasCoords = (clientX, clientY) => {
        const rect = canvas.getBoundingClientRect();
        return {
          x: ((clientX - rect.left) / rect.width) * canvas.width,
          y: ((clientY - rect.top) / rect.height) * canvas.height
        };
      };

      const sampleSurroundingColorHex = (page, pt) => {
        const src = page.processedCanvas || page.workingCanvas;
        const sctx = src.getContext("2d");
        const r = Math.max(12, Math.round(this.cleanupBrushSize * (src.width / 400)));
        const offsets = [
          [-r, -r], [0, -r], [r, -r],
          [-r, 0],           [r, 0],
          [-r, r],  [0, r],  [r, r]
        ];
        let sr = 0, sg = 0, sb = 0, cnt = 0;
        offsets.forEach(([dx, dy]) => {
          const sx = Math.min(src.width - 1, Math.max(0, Math.round(pt.x + dx)));
          const sy = Math.min(src.height - 1, Math.max(0, Math.round(pt.y + dy)));
          const px = sctx.getImageData(sx, sy, 1, 1).data;
          sr += px[0];
          sg += px[1];
          sb += px[2];
          cnt++;
        });
        return `rgb(${Math.round(sr / cnt)}, ${Math.round(sg / cnt)}, ${Math.round(sb / cnt)})`;
      };

      const drawFreehandAt = (pt, isStart = false) => {
        const page = this.pages[this.activeIndex];
        if (!page) return;
        const isCleanup = this.activeTool === "cleanup";
        const layerKey = isCleanup ? "cleanupLayer" : "markupLayer";

        if (!page[layerKey]) {
          page[layerKey] = document.createElement("canvas");
          page[layerKey].width = page.workingCanvas.width;
          page[layerKey].height = page.workingCanvas.height;
        }
        const lctx = page[layerKey].getContext("2d");
        lctx.lineCap = "round";
        lctx.lineJoin = "round";

        if (isCleanup) {
          const scaledBrush = Math.max(10, Math.round(this.cleanupBrushSize * (page.workingCanvas.width / 420)));
          lctx.lineWidth = scaledBrush;
          lctx.strokeStyle =
            this.cleanupMode === "surrounding"
              ? sampleSurroundingColorHex(page, pt)
              : this.cleanupSelectedColor;
        } else {
          lctx.strokeStyle = this.markupColor;
          lctx.lineWidth = Math.max(8, canvas.width / 95);
        }

        if (isStart) {
          lctx.beginPath();
          lctx.moveTo(pt.x, pt.y);
          lctx.lineTo(pt.x + 0.1, pt.y + 0.1);
          lctx.stroke();
        } else {
          lctx.lineTo(pt.x, pt.y);
          lctx.stroke();
        }
        this._processPagePipeline(page);
        this.renderActiveCanvas();
      };

      const onDown = (clientX, clientY) => {
        const page = this.pages[this.activeIndex];
        if (!page) return;
        const pt = getCanvasCoords(clientX, clientY);

        if (this.activeTool === "cleanup" && this.isEyedropperActive) {
          const src = page.processedCanvas || page.workingCanvas;
          const sx = Math.min(src.width - 1, Math.max(0, Math.round(pt.x)));
          const sy = Math.min(src.height - 1, Math.max(0, Math.round(pt.y)));
          const px = src.getContext("2d").getImageData(sx, sy, 1, 1).data;
          const hex = "#" + [px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, "0")).join("");
          this.setCleanupSelectedColor(hex);
          const swatch = document.getElementById("ps-cleanup-color-swatch");
          if (swatch) swatch.value = hex;
          this.isEyedropperActive = false;
          document.getElementById("ps-cleanup-eyedropper-btn")?.classList.remove("active");
          if (typeof window.showToast === "function") window.showToast(`Picked color ${hex.toUpperCase()}`, "info");
          return;
        }

        if (this.activeTool === "cleanup" || this.activeTool === "markup") {
          this.isDrawingStroke = true;
          drawFreehandAt(pt, true);
          return;
        }

        if (this.activeTool !== "crop" || page.isCropped) return;
        const hitRadius = Math.max(52, canvas.width / 13);

        const c = page.corners;
        const handles = [
          c[0],
          c[1],
          c[2],
          c[3],
          { x: (c[0].x + c[1].x) / 2, y: (c[0].y + c[1].y) / 2 },
          { x: (c[1].x + c[2].x) / 2, y: (c[1].y + c[2].y) / 2 },
          { x: (c[2].x + c[3].x) / 2, y: (c[2].y + c[3].y) / 2 },
          { x: (c[3].x + c[0].x) / 2, y: (c[3].y + c[0].y) / 2 }
        ];

        let bestIdx = -1;
        let bestDist = Infinity;
        handles.forEach((hPt, idx) => {
          const dist = Math.hypot(hPt.x - pt.x, hPt.y - pt.y);
          if (dist < hitRadius && dist < bestDist) {
            bestDist = dist;
            bestIdx = idx;
          }
        });
        this.draggingHandleIndex = bestIdx;
        this._lastDragPt = pt;
        if (bestIdx >= 0) this.renderActiveCanvas();
      };

      const onMove = (clientX, clientY) => {
        const page = this.pages[this.activeIndex];
        if (!page) return;
        const pt = getCanvasCoords(clientX, clientY);

        if (this.isDrawingStroke && (this.activeTool === "cleanup" || this.activeTool === "markup")) {
          drawFreehandAt(pt, false);
          return;
        }

        if (this.draggingHandleIndex < 0) return;
        const clampX = (v) => Math.min(canvas.width, Math.max(0, Math.round(v)));
        const clampY = (v) => Math.min(canvas.height, Math.max(0, Math.round(v)));

        if (this.draggingHandleIndex < 4) {
          page.corners[this.draggingHandleIndex] = { x: clampX(pt.x), y: clampY(pt.y) };
        } else {
          const dx = pt.x - (this._lastDragPt?.x || pt.x);
          const dy = pt.y - (this._lastDragPt?.y || pt.y);
          const edgeIdx = this.draggingHandleIndex - 4;
          const i1 = edgeIdx;
          const i2 = (edgeIdx + 1) % 4;
          page.corners[i1] = { x: clampX(page.corners[i1].x + dx), y: clampY(page.corners[i1].y + dy) };
          page.corners[i2] = { x: clampX(page.corners[i2].x + dx), y: clampY(page.corners[i2].y + dy) };
        }
        this._lastDragPt = pt;
        this.renderActiveCanvas();
      };

      const onUp = () => {
        this.isDrawingStroke = false;
        if (this.draggingHandleIndex >= 0) {
          this.draggingHandleIndex = -1;
          this.renderActiveCanvas();
        }
      };

      canvas.addEventListener("mousedown", (e) => onDown(e.clientX, e.clientY));
      window.addEventListener("mousemove", (e) => onMove(e.clientX, e.clientY));
      window.addEventListener("mouseup", onUp);

      canvas.addEventListener("touchstart", (e) => {
        if (e.touches.length === 1) onDown(e.touches[0].clientX, e.touches[0].clientY);
      }, { passive: true });
      canvas.addEventListener("touchmove", (e) => {
        if ((this.draggingHandleIndex >= 0 || this.isDrawingStroke) && e.touches.length === 1) {
          e.preventDefault();
          onMove(e.touches[0].clientX, e.touches[0].clientY);
        }
      }, { passive: false });
      window.addEventListener("touchend", onUp);
    }
  };

  window.PrintSafeScanner = Scanner;
})();