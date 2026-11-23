// ========================================================================
// 📄 PRINTSAFE CLOUD — LIVE DOCUMENT PREVIEW & VECTOR PRINT (preview.js)
// ========================================================================
let previewZoomScale = 1.0;
let previewTotalPages = 0;
let selectedPdfPagesSet = new Set();
let activePreviewPageNum = 1;

// ========================================================================
// 🖥️ FULLSCREEN PANE TOGGLE & CENTERED ZOOM / FIT SCREEN CONTROLLERS
// ========================================================================
function toggleFullscreenPane() {
  const col = document.querySelector(".integrated-preview-column");
  if (!col) return;
  const isNowFull = col.classList.toggle("fullscreen-pane");
  if (isNowFull) {
    requestAnimationFrame(() => fitPreviewToScreen());
  } else {
    previewZoomScale = 1.0;
    applyPreviewZoomTransform();
  }
}

function adjustPreviewZoom(delta) {
  previewZoomScale = Math.min(2.5, Math.max(0.35, +(previewZoomScale + delta).toFixed(2)));
  applyPreviewZoomTransform();
}

function fitPreviewToScreen() {
  const pagesArea = document.getElementById("preview-raster-pages-area");
  const firstCard = document.querySelector("#preview-raster-pages-area .preview-page-card");
  if (!pagesArea) {
    previewZoomScale = 1.0;
    applyPreviewZoomTransform();
    return;
  }

  const col = document.querySelector(".integrated-preview-column");
  const isFull = col && col.classList.contains("fullscreen-pane");
  if (!isFull) {
    previewZoomScale = 1.0;
    applyPreviewZoomTransform();
    return;
  }

  // Fit comfortably inside fullscreen stage (height & width aware)
  const availH = Math.max(320, pagesArea.clientHeight - 68);
  const availW = Math.max(320, pagesArea.clientWidth - 48);
  const firstMedia = firstCard?.querySelector(".raster-page-preview");

  if (firstMedia && firstMedia.width && firstMedia.height) {
    const aspect = firstMedia.width / firstMedia.height;
    const idealW = Math.min(availW, Math.round(availH * aspect));
    const baseFullscreenW = Math.min(820, availW);
    previewZoomScale = Math.min(1.6, Math.max(0.45, +(idealW / Math.max(1, baseFullscreenW)).toFixed(2)));
  } else {
    previewZoomScale = 0.85;
  }
  applyPreviewZoomTransform();
}

function applyPreviewZoomTransform() {
  const lbl = document.getElementById("preview-zoom-label");
  if (lbl) lbl.innerText = `${Math.round(previewZoomScale * 100)}%`;

  const col = document.querySelector(".integrated-preview-column");
  const isFull = col && col.classList.contains("fullscreen-pane");
  const pagesArea = document.getElementById("preview-raster-pages-area");
  const availW = pagesArea ? Math.max(300, pagesArea.clientWidth - 40) : 780;
  const baseWidthPx = isFull ? Math.min(820, availW) : availW;
  const targetWidthPx = Math.round(baseWidthPx * previewZoomScale);

  document.querySelectorAll("#preview-raster-pages-area .preview-page-card").forEach((card) => {
    if (isFull) {
      card.style.width = `${targetWidthPx}px`;
      card.style.maxWidth = "none";
      card.style.margin = "0 auto";
    } else {
      card.style.width = "100%";
      card.style.maxWidth = "100%";
      card.style.margin = "0 auto";
    }
  });

  document.querySelectorAll("#preview-raster-pages-area .raster-page-preview").forEach((el) => {
    el.style.width = "100%";
    el.style.maxWidth = "100%";
  });
}

// ========================================================================
// 🔢 PAGE JUMP, SELECTION & LEFT THUMBNAIL RAIL HELPERS
// ========================================================================
function jumpToPreviewPage(pageNum) {
  const total = previewTotalPages || 1;
  const p = Math.max(1, Math.min(total, parseInt(pageNum, 10) || 1));
  activePreviewPageNum = p;

  const jumpInput = document.getElementById("pdf-jump-page-input");
  if (jumpInput) jumpInput.value = p;

  const targetCard = document.getElementById(`preview-page-card-${p}`);
  if (targetCard) {
    targetCard.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  document.querySelectorAll("#fullscreen-pages-filmstrip .fs-strip-thumb").forEach((thumb) => {
    const isMatch = Number(thumb.dataset.page) === p;
    thumb.classList.toggle("active", isMatch);
    if (isMatch) {
      thumb.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });
}

function toggleSinglePdfPageSelection(pageNum, isChecked) {
  if (isChecked) {
    selectedPdfPagesSet.add(pageNum);
  } else {
    selectedPdfPagesSet.delete(pageNum);
  }

  const card = document.getElementById(`preview-page-card-${pageNum}`);
  if (card) {
    card.classList.toggle("selected-page", isChecked);
    card.classList.toggle("unselected-page", !isChecked);
  }
  syncRangeInputFromSet();
}

function toggleSelectAllPdfPages(selectAll) {
  selectedPdfPagesSet.clear();
  for (let i = 1; i <= previewTotalPages; i++) {
    if (selectAll) selectedPdfPagesSet.add(i);
    const cb = document.getElementById(`page-select-cb-${i}`);
    if (cb) cb.checked = selectAll;
    const card = document.getElementById(`preview-page-card-${i}`);
    if (card) {
      card.classList.toggle("selected-page", selectAll);
      card.classList.toggle("unselected-page", !selectAll);
    }
  }
  const rangeInput = document.getElementById("pdf-page-range-input");
  if (rangeInput) rangeInput.value = selectAll ? "" : "None";
}

function applyPageRangeSelectionInput(rawStr) {
  const clean = (rawStr || "").trim();
  if (!clean) {
    toggleSelectAllPdfPages(true);
    return;
  }

  const nextSet = new Set();
  clean.split(",").forEach((part) => {
    const seg = part.trim();
    if (!seg) return;
    if (seg.includes("-")) {
      const [a, b] = seg.split("-").map((n) => parseInt(n.trim(), 10));
      if (!isNaN(a) && !isNaN(b)) {
        const start = Math.max(1, Math.min(a, b));
        const end = Math.min(previewTotalPages, Math.max(a, b));
        for (let i = start; i <= end; i++) {
          nextSet.add(i);
        }
      }
    } else {
      const single = parseInt(seg, 10);
      if (!isNaN(single) && single >= 1 && single <= previewTotalPages) {
        nextSet.add(single);
      }
    }
  });

  selectedPdfPagesSet = nextSet;
  for (let i = 1; i <= previewTotalPages; i++) {
    const isSel = selectedPdfPagesSet.has(i);
    const cb = document.getElementById(`page-select-cb-${i}`);
    if (cb) cb.checked = isSel;
    const card = document.getElementById(`preview-page-card-${i}`);
    if (card) {
      card.classList.toggle("selected-page", isSel);
      card.classList.toggle("unselected-page", !isSel);
    }
  }
}

function syncRangeInputFromSet() {
  const rangeInput = document.getElementById("pdf-page-range-input");
  if (!rangeInput) return;
  if (selectedPdfPagesSet.size === previewTotalPages) {
    rangeInput.value = "";
  } else if (selectedPdfPagesSet.size === 0) {
    rangeInput.value = "None";
  } else {
    rangeInput.value = Array.from(selectedPdfPagesSet)
      .sort((a, b) => a - b)
      .join(", ");
  }
}

function resetPdfViewerControlsUI() {
  previewZoomScale = 1.0;
  previewTotalPages = 0;
  selectedPdfPagesSet.clear();
  activePreviewPageNum = 1;

  const controlsBar = document.getElementById("pdf-page-controls-bar");
  const filmstrip = document.getElementById("fullscreen-pages-filmstrip");
  const rangeInput = document.getElementById("pdf-page-range-input");
  const zoomLbl = document.getElementById("preview-zoom-label");

  if (controlsBar) controlsBar.style.display = "none";
  if (filmstrip) {
    filmstrip.innerHTML = "";
    filmstrip.style.display = "none";
  }
  if (rangeInput) rangeInput.value = "";
  if (zoomLbl) zoomLbl.innerText = "100%";
}

// ========================================================================
// 👁️ IN-MEMORY STREAMING PREVIEW (LOCAL, CLOUD DRIVES & HOSTING SFTP/FTP)
// ========================================================================
async function showIntegratedPreview(
  filename,
  type,
  cardElement,
  filePassword = "",
  cloudId = null,
  accountId = null,
  accountName = "Local Vault",
  provider = "local",
  storageId = null,
  remotePath = null
) {
  activeThumbnailRequests.forEach((controller) => controller.abort());
  activeThumbnailRequests = [];

  const colWrapper = document.querySelector(".integrated-preview-column");
  if (colWrapper) colWrapper.classList.add("active-pane");

  resetPdfViewerControlsUI();

  const titleDisplay = document.getElementById("preview-filename-display");
  const pagesArea = document.getElementById("preview-raster-pages-area");
  const printBtn = document.getElementById("print-action-btn");
  if (!pagesArea) return;

  document.querySelectorAll(".file-card, .file-list-row").forEach((c) => c.classList.remove("active"));
  if (cardElement) cardElement.classList.add("active");

  if (printBtn) {
    printBtn.style.display = activeRestrictions.allow_print !== false ? "inline-flex" : "none";
  }
  if (titleDisplay) {
    titleDisplay.innerHTML = `${filename.split("/").pop()} <small style="display:block;font-size:10px;color:var(--text-sub);font-weight:500;">Source: ${accountName}</small>`;
  }

  activeFile = {
    name: filename,
    type,
    base64: null,
    binary: null,
    cloudId,
    accountId,
    accountName,
    provider,
    storageId,
    remotePath
  };
  decryptedCanvasCache = [];
  pagesArea.innerHTML = `<div class="stream-loader"><div class="vault-spinner"></div><span>Streaming encrypted document...</span></div>`;

  try {
    const response = await fetch("/fetch-file-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        password: savedPassword,
        filename: filename,
        cloud_id: cloudId,
        account_id: accountId,
        storage_id: storageId,
        remote_path: remotePath,
        session_id: currentSessionId
      })
    });

    if (!response.ok) throw new Error("Could not stream file bytes.");
    const fileData = await response.json();

    activeFile.base64 = fileData.base64;
    activeFile.binary = Uint8Array.from(atob(fileData.base64), (c) => c.charCodeAt(0));

    if (type === "pdf") {
      const loadingTask = pdfjsLib.getDocument({
        data: activeFile.binary.buffer.slice(0),
        password: filePassword
      });
      loadingTask.promise
        .then(async (pdf) => {
          previewTotalPages = pdf.numPages;
          selectedPdfPagesSet.clear();
          for (let i = 1; i <= previewTotalPages; i++) selectedPdfPagesSet.add(i);

          const controlsBar = document.getElementById("pdf-page-controls-bar");
          const jumpInput = document.getElementById("pdf-jump-page-input");
          const jumpTotalLbl = document.getElementById("pdf-jump-total-label");
          const filmstrip = document.getElementById("fullscreen-pages-filmstrip");

          if (controlsBar) controlsBar.style.display = "flex";
          if (jumpInput) {
            jumpInput.max = previewTotalPages;
            jumpInput.value = 1;
          }
          if (jumpTotalLbl) jumpTotalLbl.innerText = `/ ${previewTotalPages}`;
          if (filmstrip) filmstrip.innerHTML = "";

          pagesArea.innerHTML = "";

          for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);

            const pageCard = document.createElement("div");
            pageCard.id = `preview-page-card-${pageNum}`;
            pageCard.className = "preview-page-card selected-page";

            const headerBar = document.createElement("div");
            headerBar.className = "preview-page-header-bar";
            headerBar.innerHTML = `
              <span>Page ${pageNum} of ${pdf.numPages}</span>
              <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;color:var(--text-title);">
                <input type="checkbox" id="page-select-cb-${pageNum}" checked onchange="toggleSinglePdfPageSelection(${pageNum}, this.checked)" style="accent-color:var(--accent);width:14px;height:14px;cursor:pointer;" />
                <span>Include in Print</span>
              </label>
            `;
            pageCard.appendChild(headerBar);

            const canvas = document.createElement("canvas");
            canvas.className = "raster-page-preview";
            const viewport = page.getViewport({ scale: 1.35 });
            canvas.height = viewport.height;
            canvas.width = viewport.width;
            await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
            pageCard.appendChild(canvas);
            pagesArea.appendChild(pageCard);

            // Adobe-Style Left Sidebar Thumbnail (Visible in Fullscreen)
            if (filmstrip) {
              const stripItem = document.createElement("div");
              stripItem.className = `fs-strip-thumb ${pageNum === 1 ? "active" : ""}`;
              stripItem.dataset.page = String(pageNum);
              stripItem.title = `Jump to Page ${pageNum}`;
              stripItem.onclick = () => jumpToPreviewPage(pageNum);

              const thumbImg = document.createElement("img");
              thumbImg.src = canvas.toDataURL("image/jpeg", 0.65);
              thumbImg.alt = `Page ${pageNum}`;

              const numTag = document.createElement("span");
              numTag.className = "fs-strip-num";
              numTag.innerText = `Page ${pageNum}`;

              stripItem.appendChild(thumbImg);
              stripItem.appendChild(numTag);
              filmstrip.appendChild(stripItem);
            }

            // High-DPI Print Canvas (2.5x scale)
            const printCanvas = document.createElement("canvas");
            const printViewport = page.getViewport({ scale: 2.5 });
            printCanvas.height = printViewport.height;
            printCanvas.width = printViewport.width;
            await page.render({ canvasContext: printCanvas.getContext("2d"), viewport: printViewport }).promise;
            decryptedCanvasCache.push(printCanvas);
          }

          if (colWrapper && colWrapper.classList.contains("fullscreen-pane")) {
            fitPreviewToScreen();
          } else {
            applyPreviewZoomTransform();
          }
        })
        .catch((err) => {
          if (err.name === "PasswordException") {
            protectedFilesList[filename] = true;
            pagesArea.innerHTML = `
              <div class="file-lock-form" style="padding:24px;text-align:center;">
                <i class="ri-lock-password-line" style="font-size:32px;color:var(--accent);"></i>
                <p style="font-size:13px;margin:10px 0;">Password Protected PDF</p>
                <input type="password" id="file-inner-pass" placeholder="Enter PDF Password" style="width:100%;padding:10px;margin-bottom:10px;border-radius:var(--radius-btn);border:1px solid var(--border);background:var(--bg-app);color:var(--text-title);">
                <button class="primary-submit-btn" onclick="submitFilePassword('${filename}', '${cloudId || ""}', '${accountId || ""}', '${storageId || ""}', '${remotePath || ""}')">Decrypt</button>
              </div>`;
            pagesArea.querySelector(".file-lock-form").cardRef = cardElement;
          }
        });
    } else {
      previewTotalPages = 1;
      pagesArea.innerHTML = "";
      const pageCard = document.createElement("div");
      pageCard.id = "preview-page-card-1";
      pageCard.className = "preview-page-card selected-page";

      const img = document.createElement("img");
      img.className = "raster-page-preview";
      img.src = `data:image/jpeg;base64,${fileData.base64}`;
      pageCard.appendChild(img);
      pagesArea.appendChild(pageCard);

      const filmstrip = document.getElementById("fullscreen-pages-filmstrip");
      if (filmstrip) {
        filmstrip.innerHTML = `
          <div class="fs-strip-thumb active" data-page="1" onclick="jumpToPreviewPage(1)">
            <img src="data:image/jpeg;base64,${fileData.base64}" alt="Page 1" />
            <span class="fs-strip-num">Page 1</span>
          </div>`;
      }
      applyPreviewZoomTransform();
    }
  } catch (error) {
    pagesArea.innerHTML = `<div style='color:#ef4444; padding:30px; text-align:center; font-size:13px;'><i class="ri-error-warning-line" style="font-size:28px;display:block;margin-bottom:6px;"></i>${error.message}</div>`;
  }
}

// ========================================================================
// ❌ CLOSE PREVIEW & SUBMIT PROTECTED PDF PASSWORD
// ========================================================================
function closePreviewPane() {
  const colWrapper = document.querySelector(".integrated-preview-column");
  if (colWrapper) {
    colWrapper.classList.remove("active-pane");
    colWrapper.classList.remove("fullscreen-pane");
  }
  document.querySelectorAll(".file-card, .file-list-row").forEach((c) => c.classList.remove("active"));
  resetPdfViewerControlsUI();
  activeFile = { name: null, type: null, base64: null, binary: null };
  decryptedCanvasCache = [];
}

function submitFilePassword(filename, cloudId, accountId, storageId = "", remotePath = "") {
  const container = document.getElementById("preview-raster-pages-area");
  const cardElement = container.querySelector(".file-lock-form").cardRef;
  const enteredPass = document.getElementById("file-inner-pass").value;
  if (!enteredPass) return;
  showIntegratedPreview(
    filename,
    "pdf",
    cardElement,
    enteredPass,
    cloudId || null,
    accountId || null,
    activeFile.accountName || "Vault",
    activeFile.provider || "local",
    storageId || null,
    remotePath || null
  );
}

// ========================================================================
// 🖨️ ZERO-FOOTPRINT SELECTIVE PAGE VECTOR PRINT ENGINE
// ========================================================================
function triggerCleanVectorPrint() {
  if (!activeFile.base64) return;
  const isPdf = activeFile.type === "pdf";

  if (isPdf && previewTotalPages > 0 && selectedPdfPagesSet.size === 0) {
    if (typeof showToast === "function") {
      showToast("Please select at least 1 page to print.", "error");
    }
    return;
  }

  const existingFrame = document.getElementById("hidden-print-iframe");
  if (existingFrame) document.body.removeChild(existingFrame);

  const iframe = document.createElement("iframe");
  iframe.id = "hidden-print-iframe";
  iframe.style.cssText = "position:fixed;width:0;height:0;border:none;visibility:hidden;";
  document.body.appendChild(iframe);

  function cleanupPrintStream() {
    if (document.body.contains(iframe)) document.body.removeChild(iframe);
  }
  iframe.contentWindow.onafterprint = cleanupPrintStream;

  const isSubsetSelected = isPdf && decryptedCanvasCache.length > 0 && selectedPdfPagesSet.size < previewTotalPages;

  if (isPdf && decryptedCanvasCache.length > 0 && (isSubsetSelected || protectedFilesList[activeFile.name])) {
    const sortedPages = Array.from(selectedPdfPagesSet).sort((a, b) => a - b);
    const pdoc = iframe.contentWindow.document;
    pdoc.open();
    pdoc.write(`<!DOCTYPE html><html><head><style>body{margin:0;text-align:center;}canvas{width:100%!important;height:auto!important;display:block;page-break-after:always;}canvas:last-child{page-break-after:auto;}@page{margin:0;size:auto;}</style></head><body></body></html>`);
    pdoc.close();

    sortedPages.forEach((pageNum) => {
      const canvasElement = decryptedCanvasCache[pageNum - 1];
      if (!canvasElement) return;
      const newCanvas = pdoc.createElement("canvas");
      newCanvas.width = canvasElement.width;
      newCanvas.height = canvasElement.height;
      newCanvas.getContext("2d").drawImage(canvasElement, 0, 0);
      pdoc.body.appendChild(newCanvas);
    });

    iframe.contentWindow.focus();
    iframe.contentWindow.print();
    setTimeout(cleanupPrintStream, 1500);
  } else {
    const blob = new Blob([activeFile.binary.buffer.slice(0)], { type: isPdf ? "application/pdf" : "image/jpeg" });
    const blobURL = URL.createObjectURL(blob);
    iframe.onload = () => {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    };
    iframe.src = blobURL;
  }
}